/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { ManualPromise } from '../utils/manualPromise';
import type { SendRequestOptions } from './fetch';

// Implementation(partial) of Happy Eyeballs 2 algorithm described in
// https://www.rfc-editor.org/rfc/rfc8305

// Same as in Chromium (https://source.chromium.org/chromium/chromium/src/+/5666ff4f5077a7e2f72902f3a95f5d553ea0d88d:net/socket/transport_connect_job.cc;l=102)
const connectionAttemptDelayMs = 300;

class HttpHappyEyeballsAgent extends http.Agent {
  createConnection(options: http.ClientRequestArgs, oncreate?: (err: Error | null, socket?: net.Socket) => void): net.Socket | undefined {
    // There is no ambiguity in case of IP address.
    if (net.isIP(options.hostname!))
      return net.createConnection(options as net.NetConnectOpts);
    createConnectionAsync(options, oncreate).catch(err => oncreate?.(err));
  }
}

class HttpsHappyEyeballsAgent extends https.Agent {
  createConnection(options: http.ClientRequestArgs, oncreate?: (err: Error | null, socket?: net.Socket) => void): net.Socket | undefined {
    // There is no ambiguity in case of IP address.
    if (net.isIP(options.hostname!))
      return tls.connect(options as tls.ConnectionOptions);
    createConnectionAsync(options, oncreate).catch(err => oncreate?.(err));
  }
}

export const httpsHappyEyeballsAgent = new HttpsHappyEyeballsAgent();
export const httpHappyEyeballsAgent = new HttpHappyEyeballsAgent();

async function createConnectionAsync(options: http.ClientRequestArgs, oncreate?: (err: Error | null, socket?: net.Socket) => void) {
  const lookup = (options as SendRequestOptions).__testHookLookup || lookupAddresses;
  const addresses = await lookup(options.hostname!);
  const sockets = new Set<net.Socket>();
  let firstError;
  let errorCount = 0;
  const handleError = (socket: net.Socket, err: Error) => {
    if (!sockets.delete(socket))
      return;
    ++errorCount;
    firstError ??= err;
    if (errorCount === addresses.length)
      oncreate?.(firstError);
  };

  const connected = new ManualPromise();
  for (const { address } of addresses) {
    const socket = options.protocol === 'https:' ?
      tls.connect({
        ...(options as tls.ConnectionOptions),
        port: options.port as number,
        host: address,
        servername: options.hostname || undefined }) :
      net.createConnection({
        ...options,
        port: options.port as number,
        host: address });

    // Each socket may fire only one of 'connect', 'timeout' or 'error' events.
    // None of these events are fired after socket.destroy() is called.
    socket.on('connect', () => {
      connected.resolve();
      oncreate?.(null, socket);
      // TODO: Cache the result?
      // Close other outstanding sockets.
      sockets.delete(socket);
      for (const s of sockets)
        s.destroy();
      sockets.clear();
    });
    socket.on('timeout', () => {
      // Timeout is not an error, so we have to manually close the socket.
      socket.destroy();
      handleError(socket, new Error('Connection timeout'));
    });
    socket.on('error', e => handleError(socket, e));
    sockets.add(socket);
    await Promise.race([
      connected,
      new Promise(f => setTimeout(f, connectionAttemptDelayMs))
    ]);
    if (connected.isDone())
      break;
  }
}

async function lookupAddresses(hostname: string): Promise<dns.LookupAddress[]> {
  const addresses = await dns.promises.lookup(hostname, { all: true, family: 0, verbatim: true });
  let firstFamily = addresses.filter(({ family }) => family === 6);
  let secondFamily = addresses.filter(({ family }) => family === 4);
  // Make sure first address in the list is the same as in the original order.
  if (firstFamily.length && firstFamily[0] !== addresses[0]) {
    const tmp = firstFamily;
    firstFamily = secondFamily;
    secondFamily = tmp;
  }
  const result = [];
  // Alternate ipv6 and ipv4 addreses.
  for (let i = 0; i < Math.max(firstFamily.length, secondFamily.length); i++) {
    if (firstFamily[i])
      result.push(firstFamily[i]);
    if (secondFamily[i])
      result.push(secondFamily[i]);
  }
  return result;
}


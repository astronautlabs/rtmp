# @/rtmp

> **[📜 Adobe RTMP (December 21, 2012)](https://rtmp.veriskope.com/docs/spec/)**  
> Adobe’s Real Time Messaging Protocol (RTMP)

> 📺 Part of the **Astronaut Labs Broadcast Suite**  
> [@/is04](https://github.com/astronautlabs/is04) |
> [@/rfc8331](https://github.com/astronautlabs/rfc8331) |
> [@/rtp](https://github.com/astronautlabs/rtp) |
> [@/scte104](https://github.com/astronautlabs/scte104) | 
> [@/scte35](https://github.com/astronautlabs/scte35) | 
> [@/st2010](https://github.com/astronautlabs/st2010) | 
> [@/st291](https://github.com/astronautlabs/st291)

> 📝 **Alpha Quality**  
> This library is new, no compatibility is currently guaranteed between 
> releases (beta, semver 0.0.x).

---

Comprehensive Typescript implementation of Adobe's Real Time Messaging Protocol (RTMP) using [Bitstream](https://github.com/astronautlabs/bitstream)

# Motivation

This library is intended to provide an approachable and comprehensive RTMP implementation for Node.js using Typescript.
It uses similar concepts to those of Adobe Flash / Flash Media Server / Flex in exposing RTMP to users.

# Installation

```
npm i @astronautlabs/rtmp
```

# Examples

## Server

```typescript
import 'reflect-metadata';
import 'source-map-support/register';

import { Socket } from 'net';
import * as RTMP from '.';

class MyServer extends RTMP.Server {
    protected createSession(socket: Socket): RTMP.Session {
        return new MySession(this, socket);
    }
}

class MySession extends RTMP.Session {
    protected createStream(id: number): RTMP.ServerMediaStream {
        return new MyStream(this, id);
    }
}

class MyStream extends RTMP.ServerMediaStream {
    play(streamName: string, start: number, duration: number, reset: boolean): void {
        // Client wants to receive this stream.

        this.streamBegin();
    
        this.sendVideo(Buffer.from([ ... ]));
        this.sendAudio(Buffer.from([ ... ]));
    }

    publish(streamName : string) {
        // Client is publishing this stream
    }

    receiveVideo(data : Uint8Array) {
        // Do something with the video packets
    }

    receiveAudio(data : Uint8Array) {
        // Do something with the audio packets
    }
}

let server = new MyServer();
server.listen();
```

## Custom RPC

```typescript
import 'reflect-metadata';
import 'source-map-support/register';

import { Socket } from 'net';
import * as RTMP from '.';

class MyServer extends RTMP.Server {
    protected createSession(socket: Socket): RTMP.Session {
        return new MySession(this, socket);
    }
}

class MySession extends RTMP.Session {
    protected createStream(id: number): RTMP.ServerMediaStream {
        return new MyStream(this, id);
    }
}

class MyStream extends RTMP.ServerMediaStream {

    /**
     * Mark any method with `@RPC()` to expose it as an RTMP command.
     * Here the command 'customMethod' gets mapped to this method, with
     * its parameters automatically converted from AMF0/3 to the appropriate
     * Javascript types, and the return value being sent back in a "_result" 
     * response. If an exception is thrown, an "_error" response is sent back with 
     * a summary of the error.
     */
    @RPC() customMethod(foo : string, bar : number[]) {
        return { message: 'All done!' };
    }

    play(streamName: string, start: number, duration: number, reset: boolean): void {
        console.log(`play('${streamName}', ${start}, ${duration}, ${reset})`);
        super.play(streamName, start, duration, reset);
    }
}

let server = new MyServer();
server.listen();
```

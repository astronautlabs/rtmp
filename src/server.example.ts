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
        console.log(`play('${streamName}', ${start}, ${duration}, ${reset})`);
        super.play(streamName, start, duration, reset);
    }
}

let server = new MyServer();
server.listen();

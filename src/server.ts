import { ChunkStreams, ChunkStreamSession, CommandAMF0Data, CommandAMF3Data, ConnectCommandObject, Message, 
    MessageStreams, ProtocolMessageType, StreamBeginEventData, StreamDryEventData, StreamEndEventData, 
    UserControlData, UserControlMessageType } from "./chunk-stream";
import * as net from 'net';
import { Subject } from "rxjs";

/**
 * Represents a media stream. Subclass and override the command methods to 
 * add behavior.
 */
export class ServerStream {
    constructor(readonly session : Session, readonly id : number) {
    }

    destroyed = new Subject<void>();
    messageReceived = new Subject<Message>();

    notifyBegin() {
        this.session.streamBegin(this.id);
    }

    notifyDry() {
        this.session.streamDry(this.id);
    }

    notifyEnd() {
        this.session.streamEnd(this.id);
    }

    dispose() {
        this.destroyed.next();
    }

    
    receiveCommand(commandName : string, transactionId : number, commandObject : any, parameters : any[]) {
        console.error(`RTMP: ServerStream(${this.id}): Unhandled command '${commandName}'`);
    }

    receive(message : Message) {
        this.messageReceived.next(message);
    }
}

export class ServerControlStream extends ServerStream {
    constructor(session : Session) {
        super(session, 0);
    }

    receiveCommand(commandName: string, transactionId: number, commandObject: any, parameters: any[]): void {
        this.session.receiveCommand(commandName, transactionId, commandObject, parameters);
    }
}

export class ServerMediaStream extends ServerStream {
    pause(paused : boolean, milliseconds : number) {
        this.session.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Pause.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    seek(milliseconds : number) {
        this.session.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Seek.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    publish(publishName : string, publishType : 'live' | 'record' | 'append') {
        this.session.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Publish.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    play(streamName : string, start : number, duration : number, reset : boolean) {
        this.session.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Play.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    play2(params : any) {
        this.session.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Play2.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    isAudioEnabled = false;
    isVideoEnabled = false;

    audioEnabled = new Subject<boolean>();
    videoEnabled = new Subject<boolean>();

    enableAudio(enabled : boolean) {
        this.isAudioEnabled = enabled;
        if (enabled) {
            this.session.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking audio`
            }]);
            this.session.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Playing audio`
            }]);
        }

        this.audioEnabled.next(enabled);
    }

    enableVideo(enabled : boolean) {
        this.isVideoEnabled = enabled;
        if (enabled) {
            this.session.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking video`
            }]);
            this.session.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Playing video`
            }]);
        }

        this.videoEnabled.next(enabled);
    }

    sendVideo(timestamp : number, buffer : Buffer) {    
        if (!this.isVideoEnabled)
            return;
        this.session.chunkSession.send({
            messageTypeId: ProtocolMessageType.Audio,
            messageStreamId: this.id,
            chunkStreamId: ChunkStreams.Audio,
            timestamp,
            buffer
        });
    }

    sendAudio(timestamp : number, buffer : Buffer) {
        if (!this.isAudioEnabled)
            return;
        this.session.chunkSession.send({
            messageTypeId: ProtocolMessageType.Audio,
            messageStreamId: this.id,
            chunkStreamId: ChunkStreams.Audio,
            timestamp,
            buffer
        });
    }

    /**
     * Handle a custom RPC call. Return true if it was handled, otherwise an error result is sent to the 
     * client and an error is printed to the logs.
     * 
     * @param commandName 
     * @param command 
     * @param args 
     * @returns 
     */
    call(commandName : string, command : any, args : Record<string, any>) {
        return false;
    }

    receiveCommand(commandName : string, transactionId : number, commandObject : any, parameters : any[]) {
        switch (commandName) {
            case 'deleteStream':
                // note that spec says this is on NetStream not NetConnection, but the stream ID being deleted is 
                // passed as a parameter. Supporting both is prudent in anticipation of this confusion.
                this.dispose();
                break;
            case 'play':
                this.play(parameters[0], parameters[1], parameters[2], parameters[3]);
                return;
            case 'play2':
                this.play2(parameters[0])
                break;
            case 'receiveAudio':
                this.enableAudio(parameters[0]);
                break;
            case 'receiveVideo':
                this.enableVideo(parameters[0]);
                break;
            case 'publish':
                this.publish(parameters[0], parameters[1]);
                break;
            case 'seek':
                this.seek(parameters[0]);
                break;
            case 'pause':
                this.pause(parameters[0], parameters[1]);
                break;
            default:
                let handled = this.call(commandName, commandObject, parameters[0]);
                if (!handled) {
                    this.session.sendCommand0('_error', [{
                        level: 'error',
                        code: 'NetStream.Call.Unhandled',
                        description: `The RPC call '${commandName}' is not handled by this server.`
                    }]);
                    console.error(`RTMP: Unhandled RPC call '${commandName}' on control stream. [txn=${transactionId}]`);
                    console.error(`Command Object:`);
                    console.dir(commandObject);
                    console.error(`Params:`);
                    console.dir(parameters);
                }
        }
    }
}

export class Session {
    constructor(
        readonly socket : net.Socket,
        readonly server : Server
    ) {
        // Socket
        this.server.connections.push(this);
        this.socket.on('close', () => this.server.connections = this.server.connections.filter(x => x !== this));
        
        // Chunk Session

        this.chunkSession = ChunkStreamSession.forSocket(this.socket);
        this.chunkSession.messageReceived.subscribe(m => this.receiveMessage(m));
    }
    
    chunkSession : ChunkStreamSession;

    private receiveMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.UserControl: {
                let eventData = message.data as UserControlData;
                switch (eventData.eventType) {
                    case UserControlMessageType.StreamBegin:
                        break;
                    case UserControlMessageType.StreamEOF:
                        break;
                    case UserControlMessageType.StreamDry:
                        break;
                    case UserControlMessageType.SetBufferLength:
                        break;
                    case UserControlMessageType.StreamIsRecorded:
                        break;
                    case UserControlMessageType.PingRequest:
                        break;
                    case UserControlMessageType.PingResponse:
                        break;
                    default:
                        throw new Error(`Unknown user control message type: ${eventData.eventType}`);
                }
            }
            case ProtocolMessageType.CommandAMF0:
            case ProtocolMessageType.CommandAMF3: {
                let data = <CommandAMF3Data | CommandAMF0Data> message.data;
                let receiver = message.messageStreamId === 0 ? this : this.getStream(message.messageStreamId);

                if (!receiver) {
                    this.sendCommand0('onStatus', [{
                        level: 'error',
                        code: 'NetStream.Stream.Failed',
                        description: `There is no stream with ID ${message.messageStreamId}. Use createStream first.`
                    }]);
                    return;
                }

                receiver.receiveCommand(data.commandName, data.transactionId, data.commandObject, data.parameters)
            }
            default:
                this.handleStreamMessage(message);
        }
    }

    private _streams = new Map<number,ServerStream>();

    getStream(id : number) {
        return this._streams.get(id);
    }

    private handleStreamMessage(message : Message) {
        this._streams.get(message.messageStreamId)?.receive(message);
    }

    receiveCommand(commandName: string, transactionId: number, commandObject: any, parameters: any[]) {
        switch (commandName) {
            case 'connect':
                this.onConnect(commandObject, parameters[0]);
                return;
            case 'createStream':
                this.onCreateStream(transactionId, commandObject);
                return;
            case 'deleteStream':
                // note that spec says this is on NetStream not NetConnection, but the stream ID being deleted is 
                // passed as a parameter. Supporting both is prudent in anticipation of this confusion.
                this.getStream(parameters[0])?.dispose();
                break;
            default:
                console.error(`RTMP: Unhandled RPC call '${commandName}' on control stream. [txn=${transactionId}]`);
                console.error(`Command Object:`);
                console.dir(commandObject);
                console.error(`Params:`);
                console.dir(parameters);
        }
    }

    private nextStreamID = 1;
 
    streamCreated = new Subject<ServerStream>();

    protected createStream(id : number) {
        return new ServerMediaStream(this, id);
    }

    private onCreateStream(transactionId : number, command : any) {
        let id = this.nextStreamID++;
        let stream = this.createStream(id);

        stream.destroyed.subscribe(() => {
            this._streams.delete(id);
        })
        this._streams.set(id, stream);
        this.sendCommand0('_result', [ id ], null);
        this.streamCreated.next(stream);
    }

    private onConnect(command : ConnectCommandObject, args : Record<string, any>) {
        this.chunkSession.setAcknowledgementWindow(this.server.preferredWindowSize);
        this.chunkSession.setPeerBandwidth(this.server.preferredWindowSize, 'dynamic');
        this.chunkSession.setChunkSize(this.server.preferredChunkSize);

        let controlStream = new ServerControlStream(this);
        controlStream.notifyBegin();
        this._streams.set(0, controlStream);

        this.sendCommand0('_result', [{ 
            code: 'NetConnection.Connect.Success',
            description: 'Connection succeeded',
            data: {
                version: this.server.fullVersion,
                vendor: `AL`
            }
        }], {
            transactionId: 1,
            commandObject: {
                fmsVer: `FMS/${this.server.fullVersion}`,
                capabilities: 31.0,
                mode: 1.0,
                vendor: `AL`
            }
        });
    }

    messageReceived = new Subject<Message>();

    userControl(data : UserControlData) {
        this.chunkSession.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.UserControl,
            timestamp: 0,
            buffer: Buffer.from(data.serialize())
        });
    }

    streamBegin(streamID : number) {
        this.userControl(new StreamBeginEventData().with({ streamID }));
    }

    streamEnd(streamID : number) {
        this.userControl(new StreamEndEventData().with({ streamID }));
    }

    streamDry(streamID : number) {
        this.userControl(new StreamDryEventData().with({ streamID }));
    }

    sendCommand0(commandName : string, parameters : any[], options : { transactionId? : number, commandObject? : any } = {}) {
        let transactionId = options.transactionId ?? 0;
        let commandObject = options.commandObject ?? null;

        this.chunkSession.send({
            chunkStreamId: ChunkStreams.Invoke,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.CommandAMF0,
            timestamp: 0,
            buffer: Buffer.from(new CommandAMF0Data().with({ 
                commandName,
                transactionId,
                commandObject,
                parameters
            }).serialize())
        });
    }

    sendCommand3(commandName : string, parameters : any[], options : { transactionId? : number, commandObject? : any } = {}) {
        let transactionId = options.transactionId ?? 0;
        let commandObject = options.commandObject ?? null;

        this.chunkSession.send({
            chunkStreamId: ChunkStreams.Invoke,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.CommandAMF3,
            timestamp: 0,
            buffer: Buffer.from(new CommandAMF3Data().with({ 
                commandName,
                transactionId,
                commandObject,
                parameters
            }).serialize())
        });
    }
}

export class Server {
    constructor(readonly port = 1935) {

    }

    public version = 3;
    public fullVersion = "3,1,1,2022";
    private _server : net.Server;
    public connections : Session[] = [];
    preferredWindowSize = 5000000;
    preferredChunkSize = 128;

    protected createSession(socket : net.Socket) {
        return new Session(socket, this);
    }

    async listen() {
        this._server = new net.Server(socket => this.createSession(socket));
        this._server.listen(this.port);
    }
}
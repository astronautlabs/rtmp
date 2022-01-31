import { AbortMessageData, AcknowledgementData, C1_RANDOM_SIZE, ChunkHeader, ChunkHeader0, ChunkStreamReader, ChunkStreams, ChunkStreamWriter, CommandAMF0Data, CommandAMF3Data, ConnectCommandObject, Handshake0, Handshake1, Handshake2, HandshakeState, Message, MessageStreams, MultiplexedStreamState, ProtocolMessageType, SetChunkSizeData, SetPeerBandwidthData, UserControlData, UserControlMessageType, WindowAcknowledgementSizeData } from "./chunk-stream";
import * as crypto from 'crypto';
import * as net from 'net';
import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";
import { Observable, Subject } from "rxjs";

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
        this.session.chunkWriter.streamBegin(this.id);
    }

    notifyDry() {
        this.session.chunkWriter.streamDry(this.id);
    }

    notifyEnd() {
        this.session.chunkWriter.streamEnd(this.id);
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
        this.session.chunkWriter.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Pause.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    seek(milliseconds : number) {
        this.session.chunkWriter.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Seek.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    publish(publishName : string, publishType : 'live' | 'record' | 'append') {
        this.session.chunkWriter.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Publish.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    play(streamName : string, start : number, duration : number, reset : boolean) {
        this.session.chunkWriter.sendCommand0('onStatus', [{
            level: 'error',
            code: 'NetStream.Play.NotImplemented',
            description: `This operation is not implemented for this stream`
        }]);
    }

    play2(params : any) {
        this.session.chunkWriter.sendCommand0('onStatus', [{
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
            this.session.chunkWriter.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking audio`
            }]);
            this.session.chunkWriter.sendCommand0('onStatus', [{
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
            this.session.chunkWriter.sendCommand0('onStatus', [{
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking video`
            }]);
            this.session.chunkWriter.sendCommand0('onStatus', [{
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
        this.session.chunkWriter.send({
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
        this.session.chunkWriter.send({
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
                    this.session.chunkWriter.sendCommand0('_error', [{
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
        this.readState.windowSize = server.preferredWindowSize;
        this.writeState.windowSize = server.preferredWindowSize;
        this.writeState.maxChunkSize = server.preferredChunkSize;
        
        this.server.connections.push(this);
        this.reader = new BitstreamReader();
        this.writer = new BitstreamWriter(socket);
        this.chunkWriter = new ChunkStreamWriter(this.writer);
        this.socket.on('data', data => this.reader.addBuffer(data));
        this.socket.on('close', () => this.server.connections = this.server.connections.filter(x => x !== this));
        this.handle();
    }

    chunkWriter : ChunkStreamWriter;
    maxChunkSize = 128;
    reader : BitstreamReader;
    writer : BitstreamWriter;
    handshakeState : HandshakeState;
    clientVersion : number;
    chunkStreamMap = new Map<number, ChunkStreamReader>();
    windowSize : number;

    readState : MultiplexedStreamState = {
        maxChunkSize: this.maxChunkSize,
        windowSize: 0,
        limitType: 1,
        sequenceNumber: 0,
        hasExtendedTimestamp: false
    };

    writeState : MultiplexedStreamState = {
        maxChunkSize: this.maxChunkSize,
        windowSize: 0,
        limitType: 1,
        sequenceNumber: 0,
        hasExtendedTimestamp: false
    };

    get chunkStreams() {
        return Array.from(this.chunkStreamMap.values());
    }

    private handleMessage(message : Message) {
        if (message.messageStreamId === 0)
            this.handleControlMessage(message);
        else
            this.handleStreamMessage(message);
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

    private handleControlMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.SetChunkSize: {
                this.maxChunkSize = Math.min(Math.max(1, (message.data as SetChunkSizeData).chunkSize), 16777215);
                this.chunkStreams.forEach(s => s.maxChunkSize = this.maxChunkSize);
            } break;
            case ProtocolMessageType.AbortMessage: {
                this.getChunkStream((message.data as AbortMessageData).chunkStreamId).abortMessage();
            } break;
            case ProtocolMessageType.Acknowledgement: {
                this.readState.sequenceNumber = (message.data as AcknowledgementData).sequenceNumber;
            } break;
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
            case ProtocolMessageType.WindowAcknowledgementSize: {
                this.readState.windowSize = (message.data as WindowAcknowledgementSizeData).acknowledgementWindowSize;
            } break;
            case ProtocolMessageType.SetPeerBandwidth: {
                let data = message.data as SetPeerBandwidthData;

                if (data.limitType === 0)
                    this.writeState.windowSize = data.acknowledgementWindowSize;
                else if (data.limitType === 1)
                    this.writeState.windowSize = Math.min(this.writeState.windowSize, data.acknowledgementWindowSize);
                else if (data.limitType === 2 && this.writeState.limitType === 0) {
                    this.writeState.windowSize = data.acknowledgementWindowSize;
                    data.limitType = 0;
                }
                
                this.writeState.limitType = data.limitType;
            } break;
            case ProtocolMessageType.CommandAMF0:
            case ProtocolMessageType.CommandAMF3: {
                let data = <CommandAMF3Data | CommandAMF0Data> message.data as CommandAMF3Data;
                let receiver = message.messageStreamId === 0 ? this : this.getStream(message.messageStreamId);

                if (!receiver) {
                    this.chunkWriter.sendCommand0('onStatus', [{
                        level: 'error',
                        code: 'NetStream.Stream.Failed',
                        description: `There is no stream with ID ${message.messageStreamId}. Use createStream first.`
                    }]);
                    return;
                }

                receiver.receiveCommand(data.commandName, data.transactionId, data.commandObject, data.parameters)
            }
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
        this.chunkWriter.sendCommand0('_result', [ id ], null);
        this.streamCreated.next(stream);
    }

    private onConnect(command : ConnectCommandObject, args : Record<string, any>) {
        this.chunkWriter.setAcknowledgementWindow(this.writeState.windowSize);
        this.chunkWriter.setPeerBandwidth(this.readState.windowSize, 'dynamic');
        this.chunkWriter.setChunkSize(this.writeState.maxChunkSize);

        let controlStream = new ServerControlStream(this);
        controlStream.notifyBegin();
        this._streams.set(0, controlStream);

        this.chunkWriter.sendCommand0('_result', [{ 
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

    private async handle() {
        await this.handshake();

        this.messageReceived.subscribe(message => this.handleMessage(message));

        let chunkStreamId : number = undefined;

        while (true) {
            let chunkHeader = await ChunkHeader.readBlocking(this.reader, { params: [ this.readState ] });

            if (chunkHeader.chunkStreamId !== undefined)
                chunkStreamId = chunkHeader.chunkStreamId;
            
            let chunkStream = this.getChunkStream(chunkStreamId);
            await chunkStream.receiveChunk(chunkHeader, this.reader);

            if (this.reader.offset >= this.readState.sequenceNumber + this.readState.windowSize) {
                this.readState.sequenceNumber += this.readState.windowSize;
                this.chunkWriter.acknowledge(this.readState.sequenceNumber);
            }
        }
    }

    messageReceived = new Subject<Message>();

    getChunkStream(chunkStreamId : number) {
        if (!this.chunkStreamMap.has(chunkStreamId)) {
            let reader = new ChunkStreamReader(chunkStreamId, this.maxChunkSize);
            reader.messageReceived.subscribe(m => this.messageReceived.next(m));
            this.chunkStreamMap.set(chunkStreamId, reader);
        }

        return this.chunkStreamMap.get(chunkStreamId);
    }

    private async handshake() {
        this.clientVersion = (await Handshake0.readBlocking(this.reader)).version;
        new Handshake0()
            .with({ version: this.server.version })
            .write(this.writer);

        let c1 = await Handshake1.readBlocking(this.reader);
        new Handshake1()
            .with({
                time: Math.floor(Date.now() / 1000),
                random: crypto.randomBytes(C1_RANDOM_SIZE)
            })
            .write(this.writer)
        ;

        let c2 = await Handshake2.readBlocking(this.reader);
        new Handshake2()
            .with({
                time: c1.time,
                time2: Math.floor(Date.now() / 1000),
                randomEcho: c1.random
            })
            .write(this.writer);
        ;
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
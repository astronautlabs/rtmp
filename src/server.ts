import { ChunkStreamSession, CONTROL_MESSAGE_STREAM_ID, Message, MessageData, ProtocolMessageType, PROTOCOL_CHUNK_STREAM_ID } from "./chunk-stream";
import * as net from 'net';
import { Subject } from "rxjs";
import { DefaultVariant, Field, Variant, VariantMarker } from "@astronautlabs/bitstream";
import { AMF3, AMF0 } from '@astronautlabs/amf';
import * as FLV from '@astronautlabs/flv';
import { AMFMessageSerializer } from "./amf-message-serializer";

@Variant((i : MessageData) => i.header.messageTypeId === ProtocolMessageType.Video)
export class VideoMessageData extends MessageData {
    @Field(0, {
        // When we carry FLV data in RTMP, we skip the tag headers that you'd normally see in an FLV body.
        // Instead we synthesize those values from the RTMP chunk stream headers.
        initializer: (tag: FLV.VideoTag, data: VideoMessageData ) => tag.header = new FLV.TagHeader().with({
            type: data.header.messageTypeId, // always ProtocolMessageType.Video AKA FLV.TagType.Video
            dataSize: data.header.messageLength,
            timestamp: data.header.timestamp & 0xFFFFFF,
            timestampExtended: data.header.timestamp >> 24,
            streamId: data.header.messageStreamId
        })
    })
    tag : FLV.VideoTag;
}

@Variant((i : MessageData) => i.header.messageTypeId === ProtocolMessageType.Audio)
export class AudioMessageData extends MessageData {
    @Field(0, {
        // When we carry FLV data in RTMP, we skip the tag headers that you'd normally see in an FLV body.
        // Instead we synthesize those values from the RTMP chunk stream headers.
        initializer: (tag: FLV.AudioTag, data: AudioMessageData ) => tag.header = new FLV.TagHeader().with({
            type: data.header.messageTypeId, // always ProtocolMessageType.Audio AKA FLV.TagType.Audio
            dataSize: data.header.messageLength,
            timestamp: data.header.basicTimestamp,
            timestampExtended: data.header.extendedTimestamp,
            streamId: data.header.messageStreamId
        })
    })
    tag : FLV.AudioTag;
}

export enum UserControlMessageType {
    StreamBegin = 0,
    StreamEOF = 1,
    StreamDry = 2,
    SetBufferLength = 3,
    StreamIsRecorded = 4,
    PingRequest = 6,
    PingResponse = 7
}

/**
 * Defines the chunk streams that various kinds of messages are sent on.
 * Note that this is completely arbitrary (except for chunk stream 2).
 * Other implementations differ on which chunk stream IDs are used, implementations
 * should not depend on this.
 */
 export enum ChunkStreams {
    /**
     * Used for Command messages (RTMP§7.2)
     */
    Invoke = 3,

    /**
     * Used for audio data
     */
    Audio = 4,

    /**
     * Used for video data
     */
    Video = 5,

    /**
     * Dedicated chunk stream for AV control operations (play/pause/publish/etc)
     * Stole the idea from ffmpeg
     */
    AvInvoke = 6
}

export const CommandParameterCount = {
    _result: 1,
    _error: 1, // Info / Streamid are optional
    onStatus: 1,
    releaseStream: 1,
    getStreamLength: 1,
    getMovLen: 1,
    FCPublish: 1,
    FCUnpublish: 1,
    FCSubscribe: 1,
    onFCPublish: 1,
    connect: 0,
    call: 1,
    createStream: 0,
    close: 0,
    play: 4,
    play2: 1,
    deleteStream: 1,
    closeStream: 0,
    receiveAudio: 1,
    receiveVideo: 1,
    publish: 2,
    seek: 1,
    pause: 2
  };

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.CommandAMF0)
export class CommandAMF0Data<T extends object = {}> extends MessageData {
    @Field(0, { array: { type: AMF0.Value }, serializer: new AMFMessageSerializer() }) 
    private $args : AMF0.Value[];

    get commandName() {
        return this.$args?.[0]?.value as string;
    }

    set commandName(value) {
        if (!this.$args)
            this.$args = [];
        
        this.$args[0] = AMF0.Value.string(value);
    }

    get transactionId() {
        return this.$args?.[1]?.value as number;
    }

    set transactionId(value) {
        if (!this.$args)
            this.$args = [];

        this.$args[1] = AMF0.Value.number(value);
    }

    get commandObject(): T {
        return this.$args?.[2]?.value as T;
    }

    set commandObject(value : T) {
        if (!this.$args)
            this.$args = [];
        
        this.$args[2] = AMF0.Value.any(value);
    }

    get parameters() {
        return this.$args.slice(3).map(x => x.value);
    }

    set parameters(value) {
        this.$args = this.$args.slice(0, 3).concat(value.map(x => AMF0.Value.any(x)));
    }
    
    inspect() { 
        return `${super.inspect()}: [${this.transactionId}] ` 
            + `${this.commandName}(${this.parameters.map(p => JSON.stringify(p)).join(', ')})`
        ;
    }
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.DataAMF3)
export class DataAMF3Data extends MessageData {
    @Field() private $name : AMF3.StringValue;
    
    get name() {
        return this.$name?.value;
    }

    set name(value) {
        this.$name = AMF3.Value.string(value);
    }

    inspect(): string {
        return `${super.inspect()}: ${this.name}`;
    }
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.DataAMF0)
export class DataAMF0Data extends MessageData {
    @Field() private $name : AMF0.StringValue;
    
    get name() {
        return this.$name?.value;
    }

    set name(value) {
        this.$name = <AMF0.StringValue>AMF0.Value.string(value);
    }
    
    inspect(): string {
        return `${super.inspect()}: ${this.name}`;
    }
}

export interface OnMetaData {
    audiosamplerate: number;
    stereo: boolean;
    width: number;
    height: number;
    framerate: number;
}

@Variant<DataAMF0Data>(i => i.name === '@setDataFrame')
export class SetDataFrameData extends DataAMF0Data {
    constructor(...args) {
        super(...args);
        this.name = '@setDataFrame';
    }

    @Field() private $key: AMF0.StringValue;
    @Field() private $value : AMF0.Value;

    get key() {
        return this.$key?.value;
    }

    set key(value) {
        this.$key = <AMF0.StringValue>AMF0.Value.string(value);
    }

    get value() {
        return this.$value?.value;
    }

    set value(value) {
        this.$value = AMF0.Value.any(value);
    }
}

@Variant<DataAMF0Data>(i => i.name === '@clearDataFrame')
export class ClearDataFrameData extends DataAMF0Data {
    constructor(...args) {
        super(...args);
        this.name = '@clearDataFrame';
    }

    @Field() private $metadata : AMF0.ObjectValue;

    get metadata() {
        return this.$metadata?.value;
    }

    set metadata(value) {
        this.$metadata = AMF0.Value.object(value);
    }
}

@Variant<DataAMF0Data>(i => i.name === '|RtmpSampleAccess')
export class RtmpSampleAccessData extends DataAMF0Data {
    constructor(...args) {
        super(...args);
        this.name = '|RtmpSampleAccess';
    }

    @Field() private $audioRestricted : AMF0.BooleanValue;
    @Field() private $videoRestricted : AMF0.BooleanValue;

    get audioRestricted() {
        return this.$audioRestricted.value;
    }

    set audioRestricted(value) {
        this.$audioRestricted = AMF0.Value.boolean(value);
    }

    get videoRestricted() {
        return this.$videoRestricted.value;
    }

    set videoRestricted(value) {
        this.$videoRestricted = AMF0.Value.boolean(value);
    }
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.CommandAMF3)
export class CommandAMF3Data<T extends object = {}> extends MessageData {
    @Field(0, { array: { type: AMF3.Value }, serializer: new AMFMessageSerializer() }) 
    private $args : AMF3.Value[];

    get commandName() {
        return this.$args?.[0]?.value as string;
    }

    set commandName(value) {
        if (!this.$args)
            this.$args = [];
        
        this.$args[0] = AMF3.Value.string(value);
    }

    get transactionId() {
        return this.$args?.[1]?.value as number;
    }

    set transactionId(value) {
        if (!this.$args)
            this.$args = [];

        this.$args[1] = AMF3.Value.double(value);
    }

    get commandObject(): T {
        return this.$args?.[2]?.value as T;
    }

    set commandObject(value : T) {
        if (!this.$args)
            this.$args = [];
        
        this.$args[2] = AMF3.Value.any(value);
    }

    get parameters() {
        return this.$args.slice(3).map(x => x.value);
    }

    set parameters(value) {
        this.$args = this.$args.slice(0, 3).concat(value.map(x => AMF3.Value.any(x)));
    }
    
    inspect() { 
        return `${super.inspect()}: [${this.transactionId}] ` 
            + `${this.commandName}(${this.parameters.map(p => JSON.stringify(p)).join(', ')})`
        ;
    }
}

export enum AudioCodecFlags {
    SUPPORT_SND_NONE = 0x0001,
    SUPPORT_SND_ADPCM = 0x0002,
    SUPPORT_SND_MP3 = 0x0004,
    SUPPORT_SND_INTEL = 0x0008,
    SUPPORT_SND_UNUSED = 0x0010,
    SUPPORT_SND_NELLY8 = 0x0020,
    SUPPORT_SND_G711A = 0x0080,
    SUPPORT_SND_G711U = 0x0100,
    SUPPORT_SND_NELLY16 = 0x0200,
    SUPPORT_SND_AAC = 0x0400,
    SUPPORT_SND_SPEEX = 0x0800,
    SUPPORT_SND_ALL = 0x0FFF
}

export enum VideoCodecFlags {
    SUPPORT_VID_UNUSED = 0x0001,
    SUPPORT_VID_JPEG = 0x0002,
    SUPPORT_VID_SORENSON = 0x0004,
    SUPPORT_VID_HOMEBREW = 0x0008,
    SUPPORT_VID_VP6 = 0x0010,
    SUPPORT_VID_VP6ALPHA = 0x0020,
    SUPPORT_VID_HOMEBREWV = 0x0040,
    SUPPORT_VID_H264 = 0x0080,
    SUPPORT_VID_ALL = 0x00FF
}

export enum VideoFunctionFlags {
    SUPPORT_VID_CLIENT_SEEK = 1
}

export enum ObjectEncoding {
    AMF0 = 0,
    AMF3 = 3
}



export interface ConnectCommandObject {
    app : string;
    flashver : string;
    swfUrl : string;
    tcUrl : string;
    fpad : boolean;
    audioCodecs : number;
    videoCodecs : number;
    videoFunction : number;
    pageUrl : string;
    objectEncoding : number;
}

@DefaultVariant()
export class UnknownMessageData extends MessageData {
    @Field(8*1) messageType : number;
    @Field(8*3) length : number;
    @Field(8*4) timestamp : number;
    @Field(8*3) messageStreamId : number;
    
    @VariantMarker()
    $marker;
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.UserControl)
export class UserControlData extends MessageData {
    @Field(8*2) eventType : number;
}



@Variant<UserControlData>(i => i.eventType === UserControlMessageType.StreamBegin)
export class StreamBeginEventData extends UserControlData {
    @Field(4*8) streamID : number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.StreamEOF)
export class StreamEndEventData extends UserControlData {
    @Field(4) streamID : number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.StreamDry)
export class StreamDryEventData extends UserControlData {
    @Field(4) streamID : number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.SetBufferLength)
export class SetBufferLengthEventData extends UserControlData {
    @Field(4) streamID : number;
    @Field(4) bufferLength : number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.StreamIsRecorded)
export class StreamIsRecordedEventData extends UserControlData {
    @Field(4) streamID : number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.PingRequest)
export class PingRequestData extends UserControlData {
    @Field(4*8) timestamp: number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.PingResponse)
export class PingResponseData extends UserControlData {
    @Field(4) timestamp: number;
}

/**
 * Represents a media stream. Subclass and override the command methods to 
 * add behavior.
 */
export class ServerStream {
    constructor(readonly session : Session, readonly id : number) {
    }

    destroyed = new Subject<void>();
    messageReceived = new Subject<Message>();
    dataReceived = new Subject<DataAMF0Data | DataAMF3Data>();

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

    receiveData(data : DataAMF0Data | DataAMF3Data) {
        this.dataReceived.next(data);
    }

    async receiveCommand(commandName : string, transactionId : number, commandObject : any, parameters : any[]) {
        console.error(`RTMP: ServerStream(${this.id}): Unhandled command '${commandName}'`);
    }

    receiveMessage(message : Message) {
        this.messageReceived.next(message);
        switch (message.typeId) {
            case ProtocolMessageType.DataAMF0:
            case ProtocolMessageType.DataAMF3: {
                let data = <DataAMF3Data | DataAMF0Data> message.data;
                this.receiveData(data);
            } break;
            case ProtocolMessageType.CommandAMF0:
            case ProtocolMessageType.CommandAMF3: {
                let data = <CommandAMF3Data | CommandAMF0Data> message.data;
                this.receiveCommand(data.commandName, data.transactionId, data.commandObject, data.parameters);
            } break;
            default:
                console.error(`RTMP: NetStream(${this.id}): Unhandled protocol message ${message.typeId}`);
        }
    }
}

export interface RPCOptions {
    enabled? : boolean;
    isVoid? : boolean;
}

export function RPC(options? : RPCOptions) {
    return Reflect.metadata('rtmp:rpc', { enabled: true, ...options });
}

export class ServerControlStream extends ServerStream {
    constructor(session : Session) {
        super(session, 0);
    }

    async receiveCommand(commandName: string, transactionId: number, commandObject: any, parameters: any[]) {
        await this.session.receiveCommand(commandName, transactionId, commandObject, parameters);
    }
}

export interface Status {
    level: 'status' | 'error';
    code: string;
    description: string;
}

export class ServerMediaStream extends ServerStream {
    sendStatus(status : Status) {
        this.session.sendCommand0('onStatus', [status], { messageStreamId: this.id });
    }

    notifyBegin() {
        super.notifyBegin();
        this.sendStatus({
            level: 'status',
            code: 'NetStream.Play.Reset',
            description: `The stream is resetting`
        });
        this.sendStatus({
            level: 'status',
            code: 'NetStream.Play.Start',
            description: `The stream is starting`
        });
    }

    metadata: Record<string, any> = {};
    metadataChanged = new Subject<Record<string, any>>();
    sampleAccessRestrictionsChanged = new Subject<{ audioRestricted: boolean, videoRestricted: boolean }>();

    receiveMetadata(key: string, value: any) {
    }

    receiveSampleRestrictions(restrictions: { audioRestricted: boolean, videoRestricted: boolean }) {
        this.sampleAccessRestrictionsChanged.next(restrictions);
    }

    sendDataFrame(key: string, value: any) {
        this.session.sendData0(new SetDataFrameData().with({ key, value }), { messageStreamId: this.id });
    }

    override receiveData(data : DataAMF0Data | DataAMF3Data) {
        if (data instanceof SetDataFrameData) {
            this.metadata[data.key] = data.value;
            this.metadataChanged.next(this.metadata);
            this.receiveMetadata(data.key, data.value);
        }

        if (data instanceof ClearDataFrameData) {
            // TODO
            //this.onDataFrameRemoved(data.metadata);
        }

        if (data instanceof RtmpSampleAccessData)
            this.receiveSampleRestrictions({ audioRestricted: data.audioRestricted, videoRestricted: data.videoRestricted });

        super.receiveData(data);
    }

    restrictSampleAccess(audioRestricted: boolean, videoRestricted: boolean) {
        this.session.sendData0(
            new RtmpSampleAccessData().with({ audioRestricted: audioRestricted, videoRestricted: videoRestricted }),
            { messageStreamId: this.id }
        )
    }

    @RPC()
    pause(paused : boolean, milliseconds : number) {
        this.sendStatus({
            level: 'error',
            code: 'NetStream.Pause.NotImplemented',
            description: `This operation is not implemented for this stream`
        });
    }

    @RPC()
    seek(milliseconds : number) {
        this.sendStatus({
            level: 'error',
            code: 'NetStream.Seek.NotImplemented',
            description: `This operation is not implemented for this stream`
        });
    }

    @RPC()
    publish(streamKey : string, publishType : 'live' | 'record' | 'append') {
        this.sendStatus({
            level: 'error',
            code: 'NetStream.Publish.NotImplemented',
            description: `This operation is not implemented for this stream`
        });
    }

    @RPC()
    private FCPublish(streamName : string) {
        return streamName;
    }
    
    @RPC({ isVoid: true })
    play(streamKey : string, start : number, duration : number, reset : boolean) {
        this.sendStatus({
            level: 'error',
            code: 'NetStream.Play.NotImplemented',
            description: `This operation is not implemented for this stream`
        });
    }

    @RPC()
    play2(params : any) {
        this.sendStatus({
            level: 'error',
            code: 'NetStream.Play2.NotImplemented',
            description: `This operation is not implemented for this stream`
        });
    }

    isAudioEnabled = true;
    isVideoEnabled = true;

    audioEnabled = new Subject<boolean>();
    videoEnabled = new Subject<boolean>();

    enableAudio(enabled : boolean) {
        this.isAudioEnabled = enabled;
        if (enabled) {
            this.sendStatus({
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking audio`
            });
            this.sendStatus({
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Playing audio`
            });
        }

        this.audioEnabled.next(enabled);
    }

    enableVideo(enabled : boolean) {
        this.isVideoEnabled = enabled;
        if (enabled) {
            this.sendStatus({
                level: 'status',
                code: 'NetStream.Seek.Notify',
                description: `Seeking video`
            });
            this.sendStatus({
                level: 'status',
                code: 'NetStream.Play.Start',
                description: `Playing video`
            });
        }

        this.videoEnabled.next(enabled);
    }

    /**
     * Send a video message. Can provide either a VideoMessageData object or an already serialized 
     * VideoMessageData object.
     * @param timestamp 
     * @param message 
     * @returns 
     */
    sendVideo(timestamp : number, message : VideoMessageData | Buffer) {
        if (!this.isVideoEnabled)
            return;
        this.session.chunkSession.send({
            messageTypeId: ProtocolMessageType.Video,
            messageStreamId: this.id,
            chunkStreamId: ChunkStreams.Video,
            timestamp,
            buffer: message instanceof MessageData ? undefined : message,
            data: message instanceof MessageData ? message : undefined,
        });
    }

    /**
     * Send an audio message. Can provide either an AudioMessageData object or an already serialized
     * AudioMessageData object.
     * @param timestamp 
     * @param message 
     * @returns 
     */
    sendAudio(timestamp : number, message : AudioMessageData | Buffer) {
        if (!this.isAudioEnabled)
            return;
        this.session.chunkSession.send({
            messageTypeId: ProtocolMessageType.Audio,
            messageStreamId: this.id,
            chunkStreamId: ChunkStreams.Audio,
            timestamp,
            buffer: message instanceof MessageData ? undefined : message,
            data: message instanceof MessageData ? message : undefined
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

    /**
     * Receive an audio message on this stream.
     * @param timestamp The timestamp of the audio message
     * @param message The decoded message
     * @param buffer The serialized message for efficient passthrough to other streams
     */
    receiveAudio(timestamp : number, message : AudioMessageData, buffer: Buffer) {

    }

    /**
     * Receive a video message on this stream.
     * @param timestamp The timestamp of the video message
     * @param message The decoded message
     * @param buffer The serialized message for efficient passthrough to other streams
     */
    receiveVideo(timestamp : number, message : VideoMessageData, buffer: Buffer) {

    }

    receiveMessage(message: Message): void {
        switch (message.typeId) {
            case ProtocolMessageType.Audio:
                this.receiveAudio(message.timestamp, message.data as AudioMessageData, message.rawData);
                break;
            case ProtocolMessageType.Video:
                this.receiveVideo(message.timestamp, message.data as VideoMessageData, message.rawData);
                break;
            default:
                super.receiveMessage(message);
        }
    }

    sendCommand0(commandName: string, parameters: any[], options : { transactionId? : number, commandObject? : any } = {}) {
        this.session.sendCommand0(commandName, parameters, { ...options, messageStreamId: this.id });
    }

    async receiveCommand(commandName : string, transactionId : number, commandObject : any, parameters : any[]) {
        switch (commandName) {
            case 'deleteStream':
                // note that spec says this is on NetStream not NetConnection, but the stream ID being deleted is 
                // passed as a parameter. Supporting both is prudent in anticipation of this confusion.
                //   https://rtmp.veriskope.com/docs/spec/#7223deletestream
                this.dispose();
                break;
            case 'receiveAudio':
                console.log(`[ServerMediaStream] receiveAudio: ${parameters[0]}`);
                this.enableAudio(parameters[0]);
                break;
            case 'receiveVideo':
                console.log(`[ServerMediaStream] receiveVideo: ${parameters[0]}`);
                this.enableVideo(parameters[0]);
                break;
            default:
                let handled = false;

                if (typeof this[commandName] === 'function') {
                    let rpc = Reflect.getMetadata('rtmp:rpc', this.constructor.prototype, commandName);
                    if (rpc?.enabled === true) {
                        try {
                            let result = await (this[commandName] as Function).apply(this, parameters);

                            if (!rpc?.isVoid) {
                                this.sendCommand0('_result', [ result ], { 
                                    transactionId
                                });
                            }
                        } catch (e) {
                            if (rpc?.isVoid)
                                throw e;
                            
                            this.sendCommand0('_error', [{
                                level: 'error',
                                code: 'NetStream.Call.Error',
                                description: `${commandName}(): ${e.message}`
                            }]);

                            console.log(`Unhandled error during stream.${commandName}(). The error has been transmitted to the client.`);
                            console.log(`Error was:`);
                            console.error(e);
                        }
                        handled = true;
                    }
                }

                if (!handled)
                    handled = this.call(commandName, commandObject, parameters[0]);
                
                if (!handled) {
                    this.sendCommand0('_error', [{
                        level: 'error',
                        code: 'NetStream.Call.Unhandled',
                        description: `The RPC call '${commandName}' is not handled by this server.`
                    }]);
                    console.error(`${globalThis.RTMP_TRACE ? `◾     ◾ | ` : ``}Unhandled RPC: stream.${commandName}(${parameters.map(p => JSON.stringify(p)).join(', ')}) [txn=${transactionId}]`);
                }
        }
    }
}

export class Session {
    constructor(
        readonly server : Server,
        readonly socket : net.Socket
    ) {
        this.pingTime = server.preferredPingTime;
        
        // Socket
        this.server.connections.push(this);
        this.socket.on('close', () => this.close());
        
        // Chunk Session

        this.chunkSession = ChunkStreamSession.forSocket(this.socket);
        this.chunkSession.messageReceived.subscribe(m => this.receiveMessage(m));
    }
    
    close() {
        if (globalThis.RTMP_TRACE)
            console.log(`RTMP: Client disconnected`);
        
        for (let [, stream] of this._streams) {
            stream.dispose();
        }

        this._streams.clear();
        this.server.connections = this.server.connections.filter(x => x !== this)
        this.socket.end();
        clearInterval(this.pingInterval);
    }

    chunkSession : ChunkStreamSession;

    private receiveMessage(message : Message) {
        if (globalThis.RTMP_TRACE) {
            console.log(
                `RTMP: 🔽     ✅ | ${message.data.inspect()} `
                + `| msid=${message.messageStreamId}, type=${message.typeId}`
            );
        }

        if (message.messageStreamId !== 0) {
            this.handleStreamMessage(message);
            return;
        }

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
            case ProtocolMessageType.DataAMF0:
            case ProtocolMessageType.DataAMF3: {
                let receiver = message.messageStreamId === 0 ? this : this.getStream(message.messageStreamId);
                let data = <DataAMF3Data | DataAMF0Data> message.data;
                receiver.receiveData(data);
            } break;
            case ProtocolMessageType.CommandAMF0:
            case ProtocolMessageType.CommandAMF3: {
                let data = <CommandAMF3Data | CommandAMF0Data> message.data;
                let receiver = message.messageStreamId === 0 ? this : this.getStream(message.messageStreamId);


                receiver.receiveCommand(data.commandName, data.transactionId, data.commandObject, data.parameters)
            } break;
            default:
                console.error(`RTMP: NetConnection: Unhandled protocol message ${message.typeId}`);
        }
    }

    private _streams = new Map<number,ServerStream>();

    getStream(id : number) {
        return this._streams.get(id);
    }

    private handleStreamMessage(message : Message) {
        let stream = this._streams.get(message.messageStreamId);
        if (stream) {
            stream.receiveMessage(message);
            return;
        }
        if ([ProtocolMessageType.CommandAMF0, ProtocolMessageType.CommandAMF3].includes(message.typeId)) {
            let data = message.data as (CommandAMF0Data | CommandAMF3Data);

            console.error(`RTMP: Received AMF command for stream ${message.messageStreamId} but this stream does not exist yet.`);

            this.sendCommand0('onStatus', [{
                level: 'error',
                code: 'NetStream.Stream.Failed',
                description: `There is no stream with ID ${message.messageStreamId}. Use createStream first.`
            }], { transactionId: data.transactionId });
        } else {
            console.error(`RTMP: Received protocol message ${message.typeId} for nonexistent message stream ${message.messageStreamId}`);
        }

        return;
    }

    dataReceived = new Subject<any>();
    receiveData(data : any) {
        this.dataReceived.next(data);
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

    async receiveCommand(commandName: string, transactionId: number, commandObject: any, parameters: any[]) {
        parameters ??= [];
        
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
                let handled = false;
                let functionExists = typeof this[commandName] === 'function';

                if (functionExists) {
                    let rpc = Reflect.getMetadata('rtmp:rpc', this.constructor.prototype, commandName);
                    if (rpc?.enabled === true) {
                        try {
                            let result = await (this[commandName] as Function).apply(this, parameters);

                            if (!rpc?.isVoid) {
                                this.sendCommand0('_result', [ result ], { 
                                    transactionId
                                });
                            }
                        } catch (e) {
                            if (rpc?.isVoid)
                                throw e;
                            
                            this.sendCommand0('_error', [{
                                level: 'error',
                                code: 'NetStream.Call.Error',
                                description: `${commandName}(): ${e.message}`
                            }]);
                        }
                        handled = true;
                    }
                }

                if (!handled)
                    handled = this.call(commandName, commandObject, parameters[0]);
                
                if (!handled) {
                    this.sendCommand0('_error', [{
                        level: 'error',
                        code: 'NetStream.Call.Unhandled',
                        description: `The RPC call '${commandName}' is not handled by this server.`
                    }]);
                    console.error(`${globalThis.RTMP_TRACE ? `◾     ◾ | ` : ``}Unhandled RPC: session.${commandName}(${parameters.map(p => JSON.stringify(p)).join(', ')}) [txn=${transactionId}]`);
                    if (functionExists) {
                        console.error(`${globalThis.RTMP_TRACE ? `◾     ◾ | ` : ``}A method named session.${commandName}() exists but is not marked as @RPC()`);
                    }
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
        this.sendCommand0('_result', [ id ], { transactionId });
        this.streamCreated.next(stream);
    }

    private pingInterval;
    private _pingTime;

    get pingTime() {
        return this._pingTime;
    }

    set pingTime(value) {
        this._pingTime = value;
        if (this.pingInterval)
            this.startPingTimer();
    }

    private startPingTimer() {
        clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => this.ping(), this.pingTime);
    }

    clientConnectInfo: ConnectCommandObject;

    private onConnect(command : ConnectCommandObject, args : Record<string, any>) {
        this.clientConnectInfo = command;
        this.startPingTimer();
        this.chunkSession.setAcknowledgementWindow(this.server.preferredWindowSize);
        this.chunkSession.setPeerBandwidth(this.server.preferredWindowSize, 'dynamic');
        this.chunkSession.setChunkSize(this.server.preferredChunkSize);

        let controlStream = new ServerControlStream(this);
        //controlStream.notifyBegin(); // Is this actually needed?
        this._streams.set(0, controlStream);

        this.sendCommand0('_result', [{
            code: 'NetConnection.Connect.Success',
            description: 'Connection succeeded',
            objectEncoding: 0,
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
            chunkStreamId: PROTOCOL_CHUNK_STREAM_ID,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.UserControl,
            timestamp: 0,
            data
        });
    }

    ping() {
        this.userControl(new PingRequestData().with({ timestamp: Date.now() }));
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

    sendCommand0(commandName : string, parameters : any[], options : { messageStreamId?: number, transactionId? : number, commandObject? : any } = {}) {
        let transactionId = options.transactionId ?? 0;
        let commandObject = options.commandObject ?? null;
        let data = new CommandAMF0Data().with({ 
            commandName,
            transactionId,
            commandObject,
            parameters
        });
        
        this.chunkSession.send({
            chunkStreamId: ChunkStreams.Invoke,
            messageStreamId: options?.messageStreamId ?? CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.CommandAMF0,
            timestamp: 0,
            data
        });
    }

    sendData0(data: DataAMF0Data, options : { messageStreamId?: number } = {}) {
        this.chunkSession.send({
            chunkStreamId: ChunkStreams.Invoke,
            messageStreamId: options?.messageStreamId ?? CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.DataAMF0,
            timestamp: 0,
            data
        });
    }

    sendCommand3(commandName : string, parameters : any[], options : { transactionId? : number, commandObject? : any } = {}) {
        let transactionId = options.transactionId ?? 0;
        let commandObject = options.commandObject ?? null;

        this.chunkSession.send({
            chunkStreamId: ChunkStreams.Invoke,
            messageStreamId: CONTROL_MESSAGE_STREAM_ID,
            messageTypeId: ProtocolMessageType.CommandAMF3,
            timestamp: 0,
            data: new CommandAMF3Data().with({ 
                commandName,
                transactionId,
                commandObject,
                parameters
            })
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
    preferredChunkSize = 60000;
    preferredPingTime = 60000;

    protected createSession(socket : net.Socket) {
        return new Session(this, socket);
    }

    async listen() {
        this._server = new net.Server(socket => this.createSession(socket));
        this._server.listen(this.port);
        console.log(`RTMP: Listening on port ${this.port}`);
    }

    stop() {
        this._server.close();
    }
}
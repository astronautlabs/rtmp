import { BitstreamElement, BitstreamReader, BitstreamWriter, DefaultVariant, Field, Variant, 
    VariantMarker } from "@astronautlabs/bitstream";
import * as net from 'net';
import * as crypto from 'crypto';
import { Observable, Subject } from "rxjs";
import { AMF0, AMF3 } from '@astronautlabs/amf';
import { Bitstream } from "./bitstream";

export class Message extends BitstreamElement {
    readonly typeId : number;
    readonly length : number;
    readonly timestamp : number;
    readonly messageStreamId : number;

    @Field() data : MessageData;
}

export interface ChunkStreamState {
    timestamp? : number;
    timestampDelta? : number;
    messageLength? : number;
    messageTypeId? : number;
    messageStreamId? : number;
    messagePayload? : Buffer;
}

export abstract class ChunkStreamId extends BitstreamElement {
    /**
     * This field identifies one of four format used by the ’chunk message header’. 
     * The ’chunk message header’ for each of the chunk types is explained in the next section.
     */
    @Field(6) csidPart1 : number;
    abstract chunkStreamId : number;
}

/**
 * One byte version of chunk stream ID (used to represent chunk stream Ids between 2 and 63)
 * https://rtmp.veriskope.com/docs/spec/#1-byte
 */
@Variant<ChunkStreamId>(i => 2 <= i.csidPart1 && i.csidPart1 <= 63)
export class ChunkStreamId1 extends ChunkStreamId {
    get chunkStreamId() { return this.csidPart1 };
}

/**
 * Two byte version of chunk stream ID (used to represent chunk stream IDs between 64 and 319)
 * https://rtmp.veriskope.com/docs/spec/#2-bytes
 */
@Variant<ChunkStreamId>(i => i.csidPart1 === 0)
export class ChunkStreamId2 extends ChunkStreamId {
    @Field(6) chunkStreamIdSub64 : number;
    get chunkStreamId() { return 64 + this.chunkStreamIdSub64; }
    set chunkStreamId(value) { this.chunkStreamIdSub64 = value; }
}

/**
 * Two byte version of chunk stream ID (used to represent chunk stream IDs between 64 and 65599)
 * https://rtmp.veriskope.com/docs/spec/#2-bytes
 */
@Variant<ChunkStreamId>(i => i.csidPart1 === 1)
export class ChunkStreamId3 extends ChunkStreamId {
    @Field(16) chunkStreamIdSub64 : number;
    get chunkStreamId() { return 64 + this.chunkStreamIdSub64; }
    set chunkStreamId(value) { this.chunkStreamIdSub64 = value; }
}

export class StreamChunk extends BitstreamElement {
    constructor(readonly streamState : ChunkStreamState) {
        super();
    }

    @Field() header : ChunkHeader;
    
}

@DefaultVariant()
export class StreamUnknownChunk extends StreamChunk {
    @Field((i : StreamUnknownChunk) => i.header?.messageLength ?? i.streamState.messageLength) data : Buffer;
}

export class ChunkHeader extends BitstreamElement {
    constructor(readonly expectsExtendedTimestamp? : boolean) {
        super();
    }

    /**
     * This field identifies one of four format used by the ’chunk message header’. 
     * The ’chunk message header’ for each of the chunk types is explained in the next section.
     */
    @Field(2) fmt : number;
    @Field() chunkStreamIdRep : ChunkStreamId;

    get chunkStreamId() {
        return this.chunkStreamIdRep?.chunkStreamId;
    }

    set chunkStreamId(value) {
        if (2 <= value && value <= 63)
            this.chunkStreamIdRep = new ChunkStreamId1().with({ chunkStreamId: value });
        else if (64 <= value && value <= 319)
            this.chunkStreamIdRep = new ChunkStreamId2().with({ chunkStreamId: value });
        else if (319 <= value && value <= 65599)
            this.chunkStreamIdRep = new ChunkStreamId3().with({ chunkStreamId: value });
        else
            throw new TypeError(`Cannot set chunk stream ID to a value greater than 65599 (max chunk stream ID)`);
    }
    
    basicTimestamp : number;
    messageLength : number;
    messageTypeId : number;
    messageStreamId : number;

    @VariantMarker() $variant;

    @Field(8*4, { presentWhen: (i : ChunkHeader) => typeof i.basicTimestamp !== 'undefined' ? i.hasExtendedTimestamp : i.expectsExtendedTimestamp })
    extendedTimestamp : number;

    get hasExtendedTimestamp() {
        return this.basicTimestamp === 0xFFFFFF;
    }

    get timestamp() {
        if (this.hasExtendedTimestamp)
            return this.extendedTimestamp;
        else
            return this.basicTimestamp;
    }

    set timestamp(value) {
        if (value >= 0xFFFFFF) {
            this.basicTimestamp = 0xFFFFFF;
            this.extendedTimestamp = value;
        } else {
            this.basicTimestamp = value;
        }
    }
}

@Variant<ChunkHeader>(i => i.fmt === 0)
export class ChunkHeader0 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
    @Field(8*4) messageStreamId : number;
}

@Variant<ChunkHeader>(i => i.fmt === 1)
export class ChunkHeader1 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
    messageStreamId : undefined;
}

@Variant<ChunkHeader>(i => i.fmt === 2)
export class ChunkHeader2 extends ChunkHeader {
    @Field(8*3) basicTimestamp : number;
    messageLength : undefined;
    messageTypeId : undefined;
    messageStreamId : undefined;
}

@Variant<ChunkHeader>(i => i.fmt === 3)
export class ChunkHeader3 extends ChunkHeader {
    basicTimestamp : undefined;
    messageLength : undefined;
    messageTypeId : undefined;
    messageStreamId : undefined;
}

export class Handshake0 extends BitstreamElement {
    /**
     * In C0, this field identifies the RTMP version requested by the client. In S0, this field identifies the RTMP 
     * version selected by the server. The version defined by this specification is 3. Values 0-2 are deprecated values 
     * used by earlier proprietary products; 4-31 are reserved for future implementations; and 32-255 are not allowed 
     * (to allow distinguishing RTMP from text-based protocols, which always start with a printable character). A 
     * server that does not recognize the client’s requested version SHOULD respond with 3. The client MAY choose to 
     * degrade to version 3, or to abandon the handshake.
     */
    @Field(8*1) version = 3;
}

export const C1_SIZE = 1536;
export const C1_RANDOM_SIZE = 1528;

export class Handshake1 extends BitstreamElement {
    /**
     * This field contains a timestamp, which SHOULD be used as the epoch for all future chunks sent from this 
     * endpoint. This may be 0, or some arbitrary value. To synchronize multiple chunkstreams, the endpoint may wish 
     * to send the current value of the other chunkstream’s timestamp.
     */
    @Field(8*4) time = 0;

    /**
     *  This field MUST be all 0s.
     */
    @Field(8*4, { writtenValue: () => 0 }) zero = 0;

    /**
     * This field can contain any arbitrary values. Since each endpoint has to distinguish between the response to the 
     * handshake it has initiated and the handshake initiated by its peer,this data SHOULD send something sufficiently 
     * random. But there is no need for cryptographically-secure randomness, or even dynamic values
     */
    @Field(8*C1_RANDOM_SIZE) random = Buffer.alloc(C1_RANDOM_SIZE);
}

export class Handshake2 extends BitstreamElement {
    /**
     * This field MUST contain the timestamp sent by the peer in S1 (for C2) or C1 (for S2).
     */
    @Field(8*4) time : number;

    /**
     * This field MUST contain the timestamp at which the previous packet(s1 or c1) sent by the peer was read.
     */
    @Field(8*4) time2 : number;

    /**
     * This field MUST contain the random data field sent by the peer in S1 (for C2) or S2 (for C1). Either peer can 
     * use the time and time2 fields together with the current timestamp as a quick estimate of the bandwidth and/or 
     * latency of the connection, but this is unlikely to be useful.
     */
    @Field(1*1528) randomEcho : Buffer;
}

export type HandshakeState = 'uninitialized' | 'versionSent' | 'ackSent' | 'handshakeDone';

export class MessageData extends BitstreamElement {
    constructor(public typeId? : number) {
        super();
    }
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.SetChunkSize)
export class SetChunkSizeData extends MessageData {
    typeId = ProtocolMessageType.SetChunkSize;

    @Field(1) zero : number;
    @Field(31) chunkSize : number;
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.AbortMessage)
export class AbortMessageData extends MessageData {
    @Field(32) chunkStreamId : number;
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.Acknowledgement)
export class AcknowledgementData extends MessageData {
    sequenceNumber : number;
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.UserControl)
export class UserControlData extends MessageData {
    @Field(8*2) eventType : number;
}



@Variant<UserControlData>(i => i.eventType === UserControlMessageType.StreamBegin)
export class StreamBeginEventData extends UserControlData {
    @Field(4) streamID : number;
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
    @Field(4) timestamp: number;
}

@Variant<UserControlData>(i => i.eventType === UserControlMessageType.PingResponse)
export class PingResponseData extends UserControlData {
    @Field(4) timestamp: number;
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.WindowAcknowledgementSize)
export class WindowAcknowledgementSizeData extends MessageData {
    @Field(8*4) acknowledgementWindowSize : number;
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.SetPeerBandwidth)
export class SetPeerBandwidthData extends MessageData {
    @Field(8*4) acknowledgementWindowSize : number;
    @Field(8*1) limitType : number;
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
    connect: 1,
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

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.CommandAMF0)
export class CommandAMF0Data<T extends object = {}> extends MessageData {
    @Field() private $commandName : AMF0.Value;
    @Field() private $transactionId : AMF0.Value;
    @Field() private $commandObject : AMF0.Value;
    
    @Field((i : CommandAMF0Data) => CommandParameterCount[i.commandName] ?? 0) private $parameters : AMF0.Value[];

    get commandName() {
        return this.$commandName?.value as string;
    }

    set commandName(value) {
        this.$commandName = AMF0.Value.string(value);
    }

    get transactionId() {
        return this.$transactionId?.value as number;
    }

    set transactionId(value) {
        this.$transactionId = AMF0.Value.number(value);
    }

    get commandObject(): T {
        return this.$commandObject?.value as T;
    }

    set commandObject(value : T) {
        this.$commandObject = AMF0.Value.object(value);
    }

    get parameters() {
        return this.$parameters.map(x => x.value);
    }
}

@Variant<MessageData>(i => i.typeId === ProtocolMessageType.CommandAMF3)
export class CommandAMF3Data<T extends object = {}> extends MessageData {
    @Field() private $commandName : AMF3.Value;
    @Field() private $transactionId : AMF3.Value;
    @Field() private $commandObject : AMF3.Value;
    
    @Field((i : CommandAMF3Data) => CommandParameterCount[i.commandName] ?? 0) private $parameters : AMF3.Value[];

    get commandName() {
        return this.$commandName?.value as string;
    }

    set commandName(value) {
        this.$commandName = AMF3.Value.string(value);
    }

    get transactionId() {
        return this.$transactionId?.value as number;
    }

    set transactionId(value) {
        this.$transactionId = AMF3.Value.double(value);
    }

    get commandObject(): T {
        return this.$commandObject?.value as T;
    }

    set commandObject(value : T) {
        this.$commandObject = AMF3.Value.object(value);
    }

    get parameters() {
        return this.$parameters.map(x => x.value);
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
export class RTMPMessageData extends MessageData {
    @Field(8*1) messageType : number;
    @Field(8*3) length : number;
    @Field(8*4) timestamp : number;
    @Field(8*3) messageStreamId : number;
    
    @VariantMarker()
    $marker;
}

@DefaultVariant()
export class UnknownRTMPMessageData extends RTMPMessageData {
    @Field((i : RTMPMessageData) => i.length)
    data : Buffer;
}

export class ChunkPayload extends BitstreamElement {
    readonly size : number;

    @Field((i : ChunkPayload) => i.size) bytes : Buffer;

    static withSize(size : number) {
        return <typeof ChunkPayload> class extends ChunkPayload {
            size = size
        };
    }
}

const MAX_TIMESTAMP = 2**32;

/**
 * Defines the chunk streams that various kinds of messages are sent on.
 * Note that this is completely arbitrary (except for chunk stream 2).
 * Other implementations differ on which chunk stream IDs are used, implementations
 * should not depend on this.
 */
export enum ChunkStreams {
    /**
     * Used for RTMP Chunk Stream protocol control messages (RTMP§5.4)
     * as well as User Control messages (RTMP§6.2)
     */
    ProtocolControl = 2,

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
    Video = 5
}

export enum MessageStreams {
    /**
     * Message stream used for all RTMP protocol messages including RTMP Chunk Stream protocol control messages
     * User Control messages and Command messages
     */
    Control = 0
}

export interface Result {
    code? : string;
    level? : string;
    description? : string;
    data : Record<string,any>;
}

export class ChunkStreamWriter {
    constructor (private bitstream : Bitstream) {
    }

    maxChunkSize = 128;
    windowSize = 0;
    limitType = 1;
    messageStreamId : number;
    timestamp : number;
    messageLength : number;
    messageTypeId : number;
    pendingMessages = new Map<number, ChunkMessage[]>();
    streamStates = new Map<number, ChunkStreamState>();

    private getQueueForStream(id : number) {
        let pending = this.pendingMessages.get(id);
        if (!pending)
            this.pendingMessages.set(id, pending = []);
        return pending;
    }

    private getStateForStream(id : number): ChunkStreamState {
        let state = this.streamStates.get(id);
        if (!state)
            this.streamStates.set(id, {});
        return state;
    }

    private discardMessageFromQueue(streamId : number) {
        let queue = this.pendingMessages.get(streamId);
        if (!queue)
            return;

        queue.shift();

        if (queue.length === 0)
            this.pendingMessages.delete(streamId);
    }

    send(message : ChunkMessage) {
        let streamQueue = this.getQueueForStream(message.chunkStreamId);
        streamQueue.push(message);

        clearTimeout(this.writeTimeout);
        this.writeTimeout = setTimeout(() => this.write());

        if (message.buffer.length < this.maxChunkSize) {
            // Send immediately without queuing
            new ChunkHeader0().with({
                chunkStreamId: message.chunkStreamId,
                messageStreamId: message.messageStreamId,
                messageTypeId: message.messageTypeId,
                messageLength: message.buffer.length
            }).write(this.bitstream.writer);
            this.bitstream.writer.writeBuffer(message.buffer);
            return;
        }
    }

    setChunkSize(chunkSize : number) {
        this.maxChunkSize = chunkSize;
        this.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.SetChunkSize,
            timestamp: 0,
            buffer: Buffer.from(
                new SetChunkSizeData()
                .with({ chunkSize })
                .serialize()
            )
        })
    }

    abortMessage(chunkStreamId : number) {
        let queue = this.pendingMessages.get(chunkStreamId);
        if (!queue || queue.length === 0)
            return;
        queue.shift();

        this.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.AbortMessage,
            timestamp: 0,
            buffer: Buffer.from(
                new AbortMessageData()
                    .with({ chunkStreamId })
                    .serialize()
            )
        })
    }

    setAcknowledgementWindow(acknowledgementWindowSize : number) {
        this.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.WindowAcknowledgementSize,
            timestamp: 0,
            buffer: Buffer.from(
                new WindowAcknowledgementSizeData()
                    .with({ acknowledgementWindowSize })
                    .serialize()
            )
        });
    }

    setPeerBandwidth(acknowledgementWindowSize : number, limitType : 'hard' | 'soft' | 'dynamic') {
        this.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.SetPeerBandwidth,
            timestamp: 0,
            buffer: Buffer.from(
                new SetPeerBandwidthData()
                    .with({ acknowledgementWindowSize, limitType: { hard: 0, soft: 1, dynamic: 2 }[limitType] })
                    .serialize()
            )
        });
    }
    
    acknowledge(sequenceNumber : number) {
        this.send({
            chunkStreamId: ChunkStreams.ProtocolControl,
            messageStreamId: MessageStreams.Control,
            messageTypeId: ProtocolMessageType.Acknowledgement,
            timestamp: 0,
            buffer: Buffer.from(
                new AcknowledgementData()
                .with({ sequenceNumber })
                .serialize()
            )
        });
    }

    private write() {
        let remainingMessages = 0;

        for (let streamId of this.pendingMessages.keys()) {
            let queue = this.pendingMessages.get(streamId);
            let message = queue?.[0];

            if (!message) {
                this.discardMessageFromQueue(streamId);
                continue;
            }

            let state = this.getStateForStream(streamId);

            if (!message.forceFullHeader && state.messageStreamId === message.messageStreamId) {
                let timestampDelta = message.timestamp - state.timestamp;

                if (state.messageLength === message.buffer.length && state.messageTypeId === message.messageTypeId) {
                    if (state.timestampDelta === timestampDelta) {
                        // Type 3
                        new ChunkHeader3()
                            .write(this.bitstream.writer);
                    } else {
                        // Type 2
                        new ChunkHeader2()
                            .with({
                                timestamp: timestampDelta
                            })
                            .write(this.bitstream.writer);
                    }
                } else {
                    // Type 1
                    new ChunkHeader1()
                        .with({
                            timestamp: timestampDelta,
                            messageLength: message.buffer.length,
                            messageTypeId: message.messageTypeId
                        })
                        .write(this.bitstream.writer);
                }

                state.timestampDelta = timestampDelta;
            } else {
                // Type 0

                new ChunkHeader0()
                    .with({
                        timestamp: message.timestamp,
                        messageLength: message.buffer.length,
                        messageTypeId: message.messageTypeId,
                        messageStreamId: message.messageStreamId
                    })
                    .write(this.bitstream.writer);

                // The semantics of timestamp delta after receiving Type 0 is unclear:
                // - Does the receiver compute the delta implicitly when receiving two consecutive Type-0's
                //   or does the last explicit timestamp delta used instead? 
                // Let's never send a Type 3 after Type 0 even if we could, so that the receiver doesn't
                // have to get the correct behavior in this case.

                state.timestampDelta = undefined;
            }
            
            let writeSize = Math.min(this.maxChunkSize, message.buffer.length - message.bytesSent);
            this.bitstream.writer.writeBuffer(message.buffer.slice(message.bytesSent, message.bytesSent + writeSize));
            message.bytesSent += writeSize;

            state.messageStreamId = message.messageStreamId;
            state.messageLength = message.buffer.length;
            state.messageTypeId = message.messageTypeId;
            state.timestamp = message.timestamp;

            let remains = message.buffer.length - message.bytesSent;
            if (remains <= 0) {
                if (remains < 0) {
                    console.error(`bug: remains should be positive (${remains})`);
                }

                this.discardMessageFromQueue(streamId);
            }

            remainingMessages += queue.length;
        }

        if (remainingMessages > 0) {
            this.writeTimeout = setTimeout(() => this.write());
        }
    }

    private writeTimeout;
}

export class ChunkStreamSession {
    constructor(readonly bitstream : Bitstream) {
        this.reader = new ChunkStreamReader(this.bitstream);
        this.writer = new ChunkStreamWriter(this.bitstream);

        this.reader.acknowledgements.subscribe(sequenceNumber => this.writer.acknowledge(sequenceNumber));
        this.reader.messageReceived.subscribe(message => this.receiveMessage(message));
    }

    readonly reader : ChunkStreamReader;
    readonly writer : ChunkStreamWriter;

    #messageReceived = new Subject<Message>();
    get messageReceived() { return this.#messageReceived; }

    private receiveMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.SetPeerBandwidth: {
                let data = message.data as SetPeerBandwidthData;

                if (data.limitType === 0)
                    this.writer.windowSize = data.acknowledgementWindowSize;
                else if (data.limitType === 1)
                    this.writer.windowSize = Math.min(this.writer.windowSize, data.acknowledgementWindowSize);
                else if (data.limitType === 2 && this.writer.limitType === 0) {
                    this.writer.windowSize = data.acknowledgementWindowSize;
                    data.limitType = 0;
                }
                
                this.writer.limitType = data.limitType;
            } break;
            default:
                this.#messageReceived.next(message);
        }
    }

    send(message : ChunkMessage) {
        this.writer.send(message);
    }

    setAcknowledgementWindow(acknowledgementWindowSize : number) {
        this.writer.setAcknowledgementWindow(acknowledgementWindowSize)
    }

    setPeerBandwidth(acknowledgementWindowSize : number, limitType : 'soft' | 'hard' | 'dynamic') {
        this.writer.setPeerBandwidth(acknowledgementWindowSize, limitType);
    }

    setChunkSize(chunkSize : number) {
        this.writer.setChunkSize(chunkSize);
    }

    static forSocket(socket : net.Socket) {
        let reader = new BitstreamReader();
        socket.on('data', data => reader.addBuffer(data));
        return new ChunkStreamSession({ reader, writer: new BitstreamWriter(socket) });
    }
}

export interface ChunkMessage {
    chunkStreamId : number;
    messageStreamId : number;
    messageTypeId : number;
    timestamp : number;
    buffer : Buffer;
    bytesSent? : number;
    forceFullHeader?: boolean;
}

export class ChunkStreamReader {
    constructor (
        private bitstream : Bitstream
    ) {
        this.start();
    }

    maxChunkSize = 128;
    chunkStreams = new Map<number, ChunkStreamState>();
    #messageReceived = new Subject<Message>();
    #controlMessageReceived = new Subject<Message>();
    #acknowledgements = new Subject<number>();

    sequenceNumber = 0;
    windowSize = 0;
    clientVersion : number;
    expectsExtendedTimestamp = false;

    get messageReceived(): Observable<Message> { return this.#messageReceived; }
    get controlMessageReceived(): Observable<Message> { return this.#controlMessageReceived; }
    get acknowledgements() { return <Observable<number>> this.#acknowledgements; }

    private async start() {
        await this.handshake();

        while (true) {
            let chunkHeader = await ChunkHeader.readBlocking(this.bitstream.reader, { params: [ this.expectsExtendedTimestamp ] });
            this.expectsExtendedTimestamp = chunkHeader.hasExtendedTimestamp;
            this.receiveChunk(chunkHeader, this.bitstream.reader);

            if (this.bitstream.reader.offset >= this.sequenceNumber + this.windowSize) {
                this.sequenceNumber += this.windowSize;
                this.#acknowledgements.next(this.sequenceNumber);
            }
        }
    }

    private async handshake() {
        this.clientVersion = (await Handshake0.readBlocking(this.bitstream.reader)).version;
        new Handshake0()
            .with({ version: 3 })
            .write(this.bitstream.writer);

        let c1 = await Handshake1.readBlocking(this.bitstream.reader);
        new Handshake1()
            .with({
                time: Math.floor(Date.now() / 1000),
                random: crypto.randomBytes(C1_RANDOM_SIZE)
            })
            .write(this.bitstream.writer)
        ;

        let c2 = await Handshake2.readBlocking(this.bitstream.reader);
        new Handshake2()
            .with({
                time: c1.time,
                time2: Math.floor(Date.now() / 1000),
                randomEcho: c1.random
            })
            .write(this.bitstream.writer);
        ;
    }

    private getChunkStream(id : number) {
        let streamState = this.chunkStreams.get(id);
        if (!streamState)
            this.chunkStreams.set(id, streamState = {});
        return streamState;
    }

    private dispatchMessage(chunkStreamId : number, message : Message) {
        if (chunkStreamId === 2)
            this.handleControlMessage(message);
        else
            this.#messageReceived.next(message);
    }
    
    private handleControlMessage(message : Message) {
        switch (message.typeId) {
            case ProtocolMessageType.SetChunkSize: {
                this.maxChunkSize = Math.min(Math.max(1, (message.data as SetChunkSizeData).chunkSize), 16777215);
            } break;
            case ProtocolMessageType.AbortMessage: {
                this.getChunkStream((message.data as AbortMessageData).chunkStreamId).messagePayload = Buffer.alloc(0);
            } break;
            case ProtocolMessageType.Acknowledgement: {
                this.sequenceNumber = (message.data as AcknowledgementData).sequenceNumber;
            } break;
            case ProtocolMessageType.WindowAcknowledgementSize: {
                this.windowSize = (message.data as WindowAcknowledgementSizeData).acknowledgementWindowSize;
            } break;
            default:
                this.#messageReceived.next(message);
        }
    }

    private async receiveChunk(header : ChunkHeader, reader : BitstreamReader) {
        let state = this.getChunkStream(header.chunkStreamId);

        // Adopt any new state values from the headers for future use

        if (header instanceof ChunkHeader0)
            state.timestamp = header.timestamp;
        else if (typeof header.timestamp !== 'undefined')
            state.timestamp = (state.timestamp + header.timestamp) % MAX_TIMESTAMP;

        state.messageStreamId = header.messageStreamId ?? state.messageStreamId;
        state.messageLength = header.messageLength ?? state.messageLength;
        state.messageTypeId = header.messageTypeId ?? state.messageTypeId;

        // Fill in all header values based on our current state. This will have the 
        // effect of expanding a compressed header to a normal Type 0 (full) header
        // for any handlers downstream from here.

        header.timestamp = state.timestamp;
        header.messageStreamId = state.messageStreamId;
        header.messageLength = state.messageLength;
        header.messageTypeId = state.messageTypeId;

        let payloadSize = Math.min(state.messageLength - state.messagePayload.length, this.maxChunkSize);
        let payload = await ChunkPayload.withSize(payloadSize).readBlocking(reader);
        state.messagePayload = Buffer.concat([state.messagePayload, payload.bytes]);

        if (state.messagePayload.length === state.messageLength) {
            this.dispatchMessage(header.chunkStreamId, new Message().with({ 
                messageStreamId: state.messageStreamId,
                length: state.messageLength,
                timestamp: state.timestamp,
                typeId: state.messageTypeId ?? header.messageTypeId,
                data: MessageData.deserialize(state.messagePayload) 
            }));
            state.messagePayload = Buffer.alloc(0);
        }
    }
}

export interface MultiplexedStreamState {
    hasExtendedTimestamp : boolean;
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

export enum ProtocolMessageType {
    SetChunkSize = 1,
    AbortMessage = 2,
    Acknowledgement = 3,
    UserControl = 4,
    WindowAcknowledgementSize = 5,
    SetPeerBandwidth = 6,
    Audio = 8,
    Video = 9,
    DataAMF3 = 15,
    SharedObjectAMF3 = 16,
    CommandAMF3 = 17,
    DataAMF0 = 18,
    SharedObjectAMF0 = 19,
    CommandAMF0 = 20,
    Aggregate = 22
}

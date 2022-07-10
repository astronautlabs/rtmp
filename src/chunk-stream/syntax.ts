import { BitstreamElement, Field, Variant, VariantMarker } from "@astronautlabs/bitstream";
import { C1_RANDOM_SIZE, ProtocolMessageType } from "./constants";
import * as FLV from '@astronautlabs/flv';

export class MessageData extends BitstreamElement {
    constructor(public header? : ChunkHeader, private bytesAvailable : number = 0) {
        super();
    }

    inspect() {
        return this.constructor.name.replace(/Data$/, '');
    }

    @VariantMarker() $variant;

    // use bitsRead instead of i.measureTo(i => i.$variant) because there are multiple valid ways to encode 
    // the same AMF data due to packing.
    @Field((i : MessageData) => i.bytesAvailable*8 - i.bitsRead) data : Uint8Array = new Uint8Array(0);
}

@Variant((i : MessageData) => i.header.messageTypeId === ProtocolMessageType.Video)
export class VideoMessageData extends MessageData {
    @Field(0, {
        // When we carry FLV data in RTMP, we skip the tag headers that you'd normally see in an FLV body.
        // Instead we synthesize those values from the RTMP chunk stream headers.
        initializer: (tag: FLV.VideoTag, data: VideoMessageData ) => tag.header = new FLV.TagHeader().with({
            type: data.header.messageTypeId, // always ProtocolMessageType.Video AKA FLV.TagType.Video
            dataSize: data.header.messageLength,
            timestamp: data.header.basicTimestamp,
            timestampExtended: data.header.extendedTimestamp,
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
    set chunkStreamId(value) { this.csidPart1 = value; }
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
    
    #messageStreamId : number;
    
    get messageStreamId() { return this.#messageStreamId; }
    set messageStreamId(value) { this.#messageStreamId = value; }

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
    fmt = 0;
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
    @Field(8*4) private $messageStreamId : Uint8Array;

    get messageStreamId() {
        if (!this.$messageStreamId)
            return undefined;
        return new DataView(this.$messageStreamId.buffer).getUint32(0, true);
    }

    set messageStreamId(value) {
        this.$messageStreamId = new Uint8Array(4);
        new DataView(this.$messageStreamId.buffer).setUint32(0, value, true);
    }
}

@Variant<ChunkHeader>(i => i.fmt === 1)
export class ChunkHeader1 extends ChunkHeader {
    fmt = 1;
    @Field(8*3) basicTimestamp : number;
    @Field(8*3) messageLength : number;
    @Field(8*1) messageTypeId : number;
}

@Variant<ChunkHeader>(i => i.fmt === 2)
export class ChunkHeader2 extends ChunkHeader {
    fmt = 2;
    @Field(8*3) basicTimestamp : number;
    messageLength : undefined;
    messageTypeId : undefined;
}

@Variant<ChunkHeader>(i => i.fmt === 3)
export class ChunkHeader3 extends ChunkHeader {
    fmt = 3;
    basicTimestamp : undefined;
    messageLength : undefined;
    messageTypeId : undefined;
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

export class Handshake1 extends BitstreamElement {
    /**
     * This field contains a timestamp, which SHOULD be used as the epoch for all future chunks sent from this 
     * endpoint. This may be 0, or some arbitrary value. To synchronize multiple chunkstreams, the endpoint may wish 
     * to send the current value of the other chunkstream’s timestamp.
     */
    @Field(8*4) time : number = 0;

    /**
     *  This field MUST be all 0s.
     */
    @Field(8*4, { writtenValue: () => 0 }) zero : number = 0;

    /**
     * This field can contain any arbitrary values. Since each endpoint has to distinguish between the response to the 
     * handshake it has initiated and the handshake initiated by its peer,this data SHOULD send something sufficiently 
     * random. But there is no need for cryptographically-secure randomness, or even dynamic values
     */
    @Field(8*C1_RANDOM_SIZE) random : Buffer = Buffer.alloc(C1_RANDOM_SIZE);
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
    @Field(8*C1_RANDOM_SIZE) randomEcho : Buffer;
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.SetChunkSize)
export class SetChunkSizeData extends MessageData {
    typeId = ProtocolMessageType.SetChunkSize;

    @Field(1) zero : number;
    @Field(31) chunkSize : number;
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.AbortMessage)
export class AbortMessageData extends MessageData {
    @Field(32) chunkStreamId : number;
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.Acknowledgement)
export class AcknowledgementData extends MessageData {
    @Field(8*4) sequenceNumber : number;

    inspect() { return `${super.inspect()}[seq=${this.sequenceNumber}]`; }
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.WindowAcknowledgementSize)
export class WindowAcknowledgementSizeData extends MessageData {
    @Field(8*4) acknowledgementWindowSize : number;
}

@Variant<MessageData>(i => i.header.messageTypeId === ProtocolMessageType.SetPeerBandwidth)
export class SetPeerBandwidthData extends MessageData {
    @Field(8*4) acknowledgementWindowSize : number;
    @Field(8*1) limitType : number;
}

export class Message extends BitstreamElement {
    readonly typeId : number;
    readonly length : number;
    readonly timestamp : number;
    readonly messageStreamId : number;
    readonly data : MessageData;
}

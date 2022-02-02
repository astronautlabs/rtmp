
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

export const MAX_TIMESTAMP = 2**32;
export const PROTOCOL_CHUNK_STREAM_ID = 2;
export const CONTROL_MESSAGE_STREAM_ID = 0;

export const C1_SIZE = 1536;
export const C1_RANDOM_SIZE = 1528;
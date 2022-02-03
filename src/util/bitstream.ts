import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";
import { AcknowledgedWritable } from "../chunk-stream/acknowledged-writable";

export interface Bitstream {
    reader : BitstreamReader;
    writable : AcknowledgedWritable;
    writer : BitstreamWriter;
}
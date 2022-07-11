import { BitstreamReader, BitstreamWriter, Writable } from "@astronautlabs/bitstream";

export interface Bitstream {
    reader : BitstreamReader;
    writable : Writable;
    writer : BitstreamWriter;
}
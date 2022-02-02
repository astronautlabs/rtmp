import { BitstreamReader, BitstreamWriter } from "@astronautlabs/bitstream";

export interface Bitstream {
    reader : BitstreamReader;
    writer : BitstreamWriter;
}
import { Writable } from "@astronautlabs/bitstream";

/**
 * Implements the acknowledgement behavior specified by the RTMP specification.
 * Bytes written to this writable will be immediately flushed to the underlying writable
 * until the number of bytes written surpasses the configured window size. When that happens,
 * the bytes will be buffered until acknowledge() is called. 
 */
export class AcknowledgedWritable implements Writable {
    constructor(private writable : Writable) {
        this.buffer = Buffer.alloc(this._bufferSize);
    }

    buffer : Uint8Array;
    bufferOffset: number = 0;
    acknowledgedOffset = 0;

    private _bufferSize = 1024;
    private _windowSize = 0;

    /**
     * How many times larger than the window size the buffer size shall be. Need not be integer.
     */
    bufferFactor = 3;

    /**
     * Size of the allocated windowing buffer. 
     * This is the maximum amount of bytes which can be stored while waiting for an acknowledgement.
     * This is 
     */
    get bufferSize() {
        return this._bufferSize;
    }

    /**
     * Gets/sets window acknowledgement size for this writable.
     */
    get windowSize() {
        return this._windowSize;
    }

    /**
     * When setting the current acknowledgement window size, the underlying storage buffer
     * is also reallocated based on the bufferFactor property.
     */
    set windowSize(value) {
        this._windowSize = value;
        this.flush();
        this.resizeBuffer(Math.min(1024 * 1024 * 100, Math.floor(value * this.bufferFactor)));
    }

    resizeBuffer(size: number) {
        if (this.bufferOffset > size)
            throw new Error(`Cannot resize acknowledgement buffer: Requested size ${size} is larger than buffer offset ${this.bufferOffset}`);
        
        let newBuffer = Buffer.alloc(size);
        newBuffer.set(this.buffer, 0);
        this.buffer = newBuffer;
        this._bufferSize = size;
    }

    /**
     * How many bytes have been sent without a corresponding acknowledgement.
     */
    unacknowledged = 0;

    acknowledge(sequenceNumber: number) {
        let delta = sequenceNumber - this.acknowledgedOffset;
        this.unacknowledged = Math.max(0, this.unacknowledged - delta);
        this.acknowledgedOffset = sequenceNumber;
        this.flush();
    }

    write(chunk: Uint8Array): void {
        // Fast path
        if (this.windowSize === 0 || this.unacknowledged + chunk.length < this.windowSize) {
            this.writable.write(chunk);
            if (this.windowSize > 0)
                this.unacknowledged += chunk.length;
            return;
        }
        
        let writableLength = this.windowSize - this.unacknowledged;
        if (writableLength > 0) {
            this.writable.write(chunk.subarray(0, writableLength));
            chunk = chunk.subarray(writableLength);
        }

        if (this.bufferOffset + chunk.length > this.buffer.length)
            throw new Error(`Buffer overrun: ${this._bufferSize} bytes unacknowledged! [window size ${this.windowSize}]`);
        
        this.buffer.set(chunk, this.bufferOffset);
        this.bufferOffset += chunk.length;
        console.log(`[AcknowledgedWritable] Buffered ${chunk.length} bytes`);
    }

    /**
     * Flush whatever contents of the buffer we can based on our state
     */
    private flush() {
        if (this.windowSize === 0) {
            this.writable.write(this.buffer.subarray(0, this.bufferOffset));
            this.bufferOffset = 0;
            return;
        }

        let writableLength = Math.min(this.windowSize - this.unacknowledged, this.bufferOffset);
        if (writableLength <= 0)
            return;
        this.writable.write(this.buffer.subarray(0, writableLength));
        let remaining = this.buffer.length - writableLength;
        this.buffer.set(this.buffer.subarray(writableLength), 0);
        this.bufferOffset = remaining;
    }
}
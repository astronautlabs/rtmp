import { Writable } from "@astronautlabs/bitstream";

export class AcknowledgedWritable implements Writable {
    constructor(private writable : Writable) {
    }

    buffer : Uint8Array = new Uint8Array(0);
    acknowledgedOffset = 0;

    maxSize = 1024 * 1024 * 10;
    private _windowSize = 0;

    get windowSize() {
        return this._windowSize;
    }

    set windowSize(value) {
        this._windowSize = value;
        this.scheduleWrite();
    }

    unacknowledged = 0;

    acknowledge(offset) {
        let delta = offset - this.acknowledgedOffset;
        this.unacknowledged = Math.max(0, this.unacknowledged - delta);
        this.acknowledgedOffset = offset;
        this.scheduleWrite();
    }

    pendingWrite;

    write(chunk: Uint8Array): void {
        if (this.buffer.length > this.maxSize)
            throw new Error(`Buffer overrun: ${this.maxSize} bytes unacknowledged! [window size ${this.windowSize}]`);
        let buf = new Uint8Array(this.buffer.length + chunk.length);
        buf.set(this.buffer);
        buf.set(chunk, this.buffer.length);
        this.buffer = buf;
        this.scheduleWrite();
    }

    private flush() {
        this.pendingWrite = undefined;
        let writable = this.buffer;

        if (this.windowSize > 0) {
            let allowed = this.windowSize - this.unacknowledged;
            if (allowed === 0)
                return;
            
            writable = this.buffer.slice(0, allowed);
            this.buffer.slice(allowed);
        } else {
            this.buffer = Buffer.alloc(0);
        }

        if (writable.length === 0)
            return;
        
        this.writable.write(writable);
        this.unacknowledged += writable.length;
    }

    private scheduleWrite() {
        if (this.pendingWrite)
            return;
        this.pendingWrite = setImmediate(() => this.flush());
    }
}
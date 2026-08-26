declare module 'pako' {
  export class Inflate {
    constructor(options?: { raw?: boolean; chunkSize?: number });
    err: number;
    msg: string;
    ended: boolean;
    onData: (chunk: Uint8Array) => void;
    push(chunk: Uint8Array, final?: boolean): boolean;
  }
}

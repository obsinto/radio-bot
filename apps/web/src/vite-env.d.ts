/// <reference types="vite/client" />

type SerialPortRequestOptions = {
  filters?: Array<{
    usbVendorId?: number;
    usbProductId?: number;
  }>;
};

type SerialOptions = {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  bufferSize?: number;
  flowControl?: "none" | "hardware";
};

type SerialOutputSignals = {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
};

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: SerialOutputSignals): Promise<void>;
}

interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}

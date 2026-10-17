function asBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

export async function deflateBytes(data: Uint8Array): Promise<Blob> {
  const stream = new Blob([asBuffer(data)]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Response(stream).blob();
}

export async function inflateBytes(source: Blob | Uint8Array): Promise<Uint8Array> {
  const stream = (source instanceof Blob ? source.stream() : new Blob([asBuffer(source)]).stream()).pipeThrough(
    new DecompressionStream('deflate'),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

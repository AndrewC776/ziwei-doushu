// Length-prefixed Brotli worker used by the preparation script.
const { brotliCompressSync, constants } = require('node:zlib');
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32BE(0)) {
    const size = input.readUInt32BE(0);
    const data = brotliCompressSync(input.subarray(4, 4 + size), { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_LGWIN]: 22 } });
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    process.stdout.write(header); process.stdout.write(data);
    input = input.subarray(4 + size);
  }
});
process.stdin.on('end', () => { if (input.length) process.exitCode = 1; });

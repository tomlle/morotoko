import { BufferPublisher } from "./publishers/buffer.js";
import { readFileSync } from "node:fs";
import { publicEncrypt, randomBytes, createCipheriv } from "node:crypto";

const apiKey = process.env.BUFFER_API_KEY?.trim();
const channelId = process.env.BUFFER_CHANNEL_ID?.trim();
if (!apiKey || !channelId) throw new Error("Buffer credentials are required");
// Queries only: never create, retry, edit or delete a social post.
const publisher = new BufferPublisher({ apiKey, channelId });
const publicKey = readFileSync(
  new URL("./buffer-diagnostic-public.pem", import.meta.url),
);
console.log(
  JSON.stringify(
    await publisher.inspectDelivery((raw) => {
      const key = randomBytes(32),
        iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
      return Buffer.from(
        JSON.stringify({
          key: publicEncrypt(publicKey, key).toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
      ).toString("base64");
    }),
    null,
    2,
  ),
);

import { BufferPublisher } from "./publishers/buffer.js";

const apiKey = process.env.BUFFER_API_KEY?.trim();
const channelId = process.env.BUFFER_CHANNEL_ID?.trim();
if (!apiKey || !channelId) throw new Error("Buffer credentials are required");
// Queries only: never create, retry, edit or delete a social post.
const publisher = new BufferPublisher({ apiKey, channelId });
console.log(JSON.stringify(await publisher.inspectDelivery(), null, 2));

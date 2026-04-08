import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// R2 credentials must be supplied via environment variables.
// Set these in web/.env.local (gitignored) — see web/.env.example.
//
//   R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET=your-bucket-name
//
// These live server-side only and are never exposed to the browser.
const R2_ENDPOINT = process.env.R2_ENDPOINT_URL;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
export const R2_BUCKET = process.env.R2_BUCKET ?? "";

if (!R2_ENDPOINT || !R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_BUCKET) {
    throw new Error(
        "R2 is not configured. Set R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY, and R2_BUCKET in web/.env.local. " +
        "See web/.env.example for the full list."
    );
}

export const r2 = new S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT,
    credentials: {
        accessKeyId: R2_ACCESS_KEY,
        secretAccessKey: R2_SECRET_KEY,
    },
});

/**
 * Generate a short-lived presigned GET URL for an R2 object so the browser
 * can fetch it directly without exposing credentials.
 */
export async function presignGet(key: string, expiresIn = 3600): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    return getSignedUrl(r2, cmd, { expiresIn });
}

/**
 * List all object keys under a prefix in our bucket.
 */
export async function listAll(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let continuationToken: string | undefined = undefined;
    do {
        const resp: Awaited<ReturnType<typeof r2.send<ListObjectsV2Command>>> = await r2.send(
            new ListObjectsV2Command({
                Bucket: R2_BUCKET,
                Prefix: prefix,
                ContinuationToken: continuationToken,
            }),
        );
        for (const obj of resp.Contents ?? []) {
            if (obj.Key) out.push(obj.Key);
        }
        continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
}

/**
 * Read a JSON object from R2.
 */
export async function getJson<T>(key: string): Promise<T | null> {
    try {
        const resp = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        const text = await resp.Body!.transformToString();
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/**
 * Write a JSON object to R2.
 */
export async function putJson(key: string, value: unknown): Promise<void> {
    await r2.send(
        new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: JSON.stringify(value, null, 2),
            ContentType: "application/json",
        }),
    );
}

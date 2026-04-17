import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// R2 credentials — loaded lazily so the app doesn't crash without them.
//
//   R2_ENDPOINT_URL=https://<account>.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET=your-bucket-name

export const R2_BUCKET = process.env.R2_BUCKET ?? "";

let _client: S3Client | null = null;

function getClient(): S3Client {
    if (_client) return _client;
    const endpoint = process.env.R2_ENDPOINT_URL;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey || !R2_BUCKET) {
        throw new Error(
            "R2 is not configured. Set R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, " +
            "R2_SECRET_ACCESS_KEY, and R2_BUCKET in web/.env.local."
        );
    }
    _client = new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
    });
    return _client;
}

export function isR2Configured(): boolean {
    return !!(
        process.env.R2_ENDPOINT_URL &&
        process.env.R2_ACCESS_KEY_ID &&
        process.env.R2_SECRET_ACCESS_KEY &&
        process.env.R2_BUCKET
    );
}

/**
 * Generate a short-lived presigned GET URL for an R2 object.
 */
export async function presignGet(key: string, expiresIn = 3600): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
    return getSignedUrl(getClient(), cmd, { expiresIn });
}

/**
 * Generate a presigned PUT URL so the browser can upload directly to R2.
 */
export async function presignPut(key: string, contentType: string, expiresIn = 3600): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType });
    return getSignedUrl(getClient(), cmd, { expiresIn });
}

/**
 * List all object keys under a prefix.
 */
export async function listAll(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let continuationToken: string | undefined = undefined;
    do {
        const resp: any = await getClient().send(
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
        const resp = await getClient().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
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
    await getClient().send(
        new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: JSON.stringify(value, null, 2),
            ContentType: "application/json",
        }),
    );
}

/**
 * Upload raw bytes to R2.
 */
export async function putObject(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await getClient().send(
        new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
        }),
    );
}

import 'dotenv/config'
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    type CreateBucketCommandInput,
    CreateBucketCommand,
    DeleteBucketCommand,
    DeleteObjectCommand,
    ListBucketsCommand,
    type CreateBucketCommandOutput,
    type DeleteBucketCommandInput,
    type DeleteBucketCommandOutput,
    type DeleteObjectCommandInput,
    type DeleteObjectCommandOutput,
    type GetObjectCommandInput,
    type GetObjectCommandOutput,
    type ListBucketsCommandInput,
    type ListBucketsCommandOutput,
    type ListObjectsV2CommandInput,
    type ListObjectsV2CommandOutput,
    type PutObjectCommandInput,
    type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";

const s3Config= ({
    region:"auto",
    // Provide your R2 endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    endpoint: process.env.S3_API!,
    forcePathStyle: true, // ✅ VERY IMPORTANT FOR R2
    credentials: {
        // Provide your R2 Access Key ID and Secret Access Key
        accessKeyId: process.env.ACCESS_KEY_ID!,
        secretAccessKey:process.env.SECRET_ACCESS_KEY!,
    },
});

export const S3 = new S3Client(s3Config);

export async function createBucket(
    params: CreateBucketCommandInput,
): Promise<CreateBucketCommandOutput> {
    const command = new CreateBucketCommand(params);
    const response = await S3.send(command);
    return response;
}

export async function deleteBucket(
    params: DeleteBucketCommandInput,
): Promise<DeleteBucketCommandOutput> {
    const command = new DeleteBucketCommand(params);
    const response = await S3.send(command);
    return response;
}

export async function listBuckets(
    params: ListBucketsCommandInput = {},
): Promise<ListBucketsCommandOutput> {
    const command = new ListBucketsCommand(params);
    const response = await S3.send(command);
    return response;
}

export async function listObjects(
    params: ListObjectsV2CommandInput,
): Promise<ListObjectsV2CommandOutput> {
    const command = new ListObjectsV2Command(params);

    const response = await S3.send(command);
    
    return response;
}

export async function getObject(
    params: GetObjectCommandInput,
): Promise<GetObjectCommandOutput> {
    const command = new GetObjectCommand(params);
    const response = await S3.send(command);
    return response;
}

export async function putObject(
    params: PutObjectCommandInput,
): Promise<PutObjectCommandOutput> {
    const command = new PutObjectCommand(params);
    const response = await S3.send(command);
    return response;
}

export async function deleteObject(
    params: DeleteObjectCommandInput,
): Promise<DeleteObjectCommandOutput> {
    const command = new DeleteObjectCommand(params);
    const response = await S3.send(command);
    return response;
}


import { GoogleGenerativeAI } from "@google/generative-ai";
import {createClient } from "redis"

export const redis = await createClient().connect()

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function createTitle(initialPrompt: string) : Promise<string> {
    const prompt = `Create a concise, catchy title for this content just one : ${initialPrompt}`;
    const result = await model.generateContent(prompt);
    console.log(result)
    const response = await result.response;
    console.log(response)
    return response.text();
}

export function createRandomJobId () {
    return Math.random().toString() + Math.random().toString()
}

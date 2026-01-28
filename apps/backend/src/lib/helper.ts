import { GoogleGenerativeAI } from "@google/generative-ai";



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


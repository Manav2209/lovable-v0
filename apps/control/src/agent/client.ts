import { ChatGroq } from "@langchain/groq";
import { MemorySaver } from "@langchain/langgraph";

class LLMClient {
    private static instance: LLMClient;
    private _model: ChatGroq;
    private _checkpointer: MemorySaver;

    private constructor() {
        this._model = new ChatGroq({
            apiKey: process.env.GROQ_API_KEY || "",
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            temperature: 0.5,
        });
        this._checkpointer = new MemorySaver();
    }

    public static getInstance(): LLMClient {
        if (!LLMClient.instance) {
            LLMClient.instance = new LLMClient();
        }
        return LLMClient.instance;
    }

    public get model(): ChatGroq {
        return this._model;
    }

    public get checkpointer(): MemorySaver {
        return this._checkpointer;
    }
}

export const llmClient = LLMClient.getInstance();

export const model = llmClient.model;
export const checkpointer = llmClient.checkpointer;
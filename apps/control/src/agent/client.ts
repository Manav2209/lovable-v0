import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { MemorySaver } from "@langchain/langgraph";
import "../observability/instrumentation";
import { injectLangfuse } from "../observability/langfuse";

export type LLMProvider = "groq" | "google" | "airouter";

function resolveProvider(): LLMProvider {
    const explicit = process.env.LLM_PROVIDER?.toLowerCase();
    if (explicit === "google" || explicit === "groq" || explicit === "airouter") {
        return explicit;
    }
    if (process.env.AIROUTER_API_KEY) {
        return "airouter";
    }
    return "groq";
}

class LLMClient {
    private static instance: LLMClient;
    private _model: BaseChatModel;
    private _provider: LLMProvider;
    private _checkpointer: MemorySaver;

    private constructor() {
        this._provider = resolveProvider();

        if (this._provider === "google") {
            this._model = injectLangfuse(
                new ChatGoogleGenerativeAI({
                    apiKey: process.env.GOOGLE_API_KEY || "",
                    model: process.env.GOOGLE_MODEL || "gemini-2.5-flash",
                    temperature: 0.5,
                }),
            );
        } else if (this._provider === "airouter") {
            this._model = injectLangfuse(
                new ChatOpenAI({
                    apiKey: process.env.AIROUTER_API_KEY || "",
                    model: process.env.AIROUTER_MODEL || "openai/gpt-4o-mini",
                    temperature: 0.5,
                    configuration: {
                        baseURL:
                            process.env.AIROUTER_BASE_URL ||
                            "https://api.airouter.in/v1",
                    },
                }),
            );
        } else {
            this._model = injectLangfuse(
                new ChatGroq({
                    apiKey: process.env.GROQ_API_KEY || "",
                    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
                    temperature: 0.5,
                }),
            );
        }

        this._checkpointer = new MemorySaver();
    }

    public static getInstance(): LLMClient {
        if (!LLMClient.instance) {
            LLMClient.instance = new LLMClient();
        }
        return LLMClient.instance;
    }

    public get model(): BaseChatModel {
        return this._model;
    }

    public get provider(): LLMProvider {
        return this._provider;
    }

    public get checkpointer(): MemorySaver {
        return this._checkpointer;
    }
}

export const llmClient = LLMClient.getInstance();

export const model = llmClient.model;
export const checkpointer = llmClient.checkpointer;

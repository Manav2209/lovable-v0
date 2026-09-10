import { ChatGroq } from "@langchain/groq";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
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

function buildModel(provider: LLMProvider, temperature: number): BaseChatModel {
    if (provider === "google") {
        return new ChatGoogleGenerativeAI({
            apiKey: process.env.GOOGLE_API_KEY || "",
            model: process.env.GOOGLE_MODEL || "gemini-2.5-flash",
            temperature,
        });
    }
    if (provider === "airouter") {
        return new ChatOpenAI({
            apiKey: process.env.AIROUTER_API_KEY || "",
            model: process.env.AIROUTER_MODEL || "openai/gpt-4o-mini",
            temperature,
            configuration: {
                baseURL:
                    process.env.AIROUTER_BASE_URL ||
                    "https://api.airouter.in/v1",
            },
        });
    }
    return new ChatGroq({
        apiKey: process.env.GROQ_API_KEY || "",
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature,
    });
}

class LLMClient {
    private static instance: LLMClient;
    private _model: BaseChatModel;
    private _frozen: BaseChatModel;
    private _provider: LLMProvider;

    private constructor() {
        this._provider = resolveProvider();
        this._model = injectLangfuse(buildModel(this._provider, 0.3));
        this._frozen = injectLangfuse(buildModel(this._provider, 0));
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

    public get frozenModel(): BaseChatModel {
        return this._frozen;
    }

    public get provider(): LLMProvider {
        return this._provider;
    }
}

export const llmClient = LLMClient.getInstance();

export const model = llmClient.model;
export const frozenModel = llmClient.frozenModel;
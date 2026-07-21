"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var shared_redis_1 = require("shared-redis");
var types_1 = require("types");
var project_1 = require("./handler/project");
var lib_1 = require("./lib");
// Redis initalization
var redis = shared_redis_1.RedisManager.getStandardClient();
// we will store the response from Control and Server Pod
// Project ->  resolver
var serverResponses = new Map();
var controlResponses = new Map();
function waitForServer(projectId) {
    return new Promise(function (resolve) {
        serverResponses.set(projectId, resolve);
    });
}
function waitForControl(projectId, timeoutMs) {
    if (timeoutMs === void 0) { timeoutMs = 60000; }
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
            controlResponses.delete(projectId);
            reject(new Error("Control pod timeout"));
        }, timeoutMs);
        controlResponses.set(projectId, function (value) {
            clearTimeout(timer);
            resolve(value);
        });
    });
}
function ListenBackend() {
    return __awaiter(this, void 0, void 0, function () {
        var lastId, response, messages, _i, messages_1, msg, msgfromBackend, type, payloadRaw, payload, projectId, jobId, prompt_1, userId;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("Listening on stream:", types_1.BackendToOrchestator);
                    lastId = "$";
                    _a.label = 1;
                case 1:
                    if (!true) return [3 /*break*/, 3];
                    return [4 /*yield*/, redis.xRead([{
                                key: types_1.BackendToOrchestator,
                                id: lastId,
                            }], {
                            BLOCK: 0
                        })];
                case 2:
                    response = _a.sent();
                    if (!response)
                        return [3 /*break*/, 1];
                    messages = response[0].messages;
                    for (_i = 0, messages_1 = messages; _i < messages_1.length; _i++) {
                        msg = messages_1[_i];
                        lastId = msg.id;
                        msgfromBackend = msg.message;
                        type = msgfromBackend.type;
                        payloadRaw = msg.message.payload;
                        payload = JSON.parse(payloadRaw);
                        console.log(payload);
                        projectId = payload.projectId, jobId = payload.jobId, prompt_1 = payload.prompt, userId = payload.userId;
                        switch (type) {
                            case types_1.CREATE_PROJECT:
                                createProject(projectId);
                                break;
                            case types_1.PROJECT_BUILD:
                                buildProject(projectId);
                                break;
                            case types_1.PROJECT_RUN:
                                runProject(projectId);
                                break;
                            case types_1.PROMPT:
                                handlePrompt(projectId, prompt_1).catch(console.error);
                                break;
                        }
                    }
                    return [3 /*break*/, 1];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function ListenControlPod() {
    return __awaiter(this, void 0, void 0, function () {
        var lastId, res, _i, _a, msg, data, resolver;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    lastId = "$";
                    _b.label = 1;
                case 1:
                    if (!true) return [3 /*break*/, 3];
                    return [4 /*yield*/, redis.xRead([{ key: types_1.ControlToOrchestator, id: lastId }], { BLOCK: 0 })];
                case 2:
                    res = _b.sent();
                    if (!res)
                        return [3 /*break*/, 1];
                    console.log(res);
                    for (_i = 0, _a = res[0].messages; _i < _a.length; _i++) {
                        msg = _a[_i];
                        lastId = msg.id;
                        data = msg.message;
                        resolver = controlResponses.get(data.projectId);
                        if (resolver) {
                            resolver(data);
                            controlResponses.delete(data.projectId);
                        }
                    }
                    return [3 /*break*/, 1];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function createProject(projectId) {
    return __awaiter(this, void 0, void 0, function () {
        var k8sName, message, response;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    k8sName = (0, lib_1.toK8sName)(projectId);
                    return [4 /*yield*/, (0, project_1.createProjectPod)(k8sName)];
                case 1:
                    _b.sent();
                    console.log("Pod created");
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToControl, "*", {
                            data: JSON.stringify({
                                type: types_1.PROJECT_INITIALIZED,
                                projectId: projectId
                            })
                        })];
                case 2:
                    message = _b.sent();
                    console.log("Message send", message);
                    return [4 /*yield*/, waitForControl(projectId)];
                case 3:
                    response = _b.sent();
                    if (!(response.type === types_1.PROJECT_INITIALIZED && response.success === "true")) return [3 /*break*/, 5];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_INITIALIZED
                            })
                        })];
                case 4:
                    _b.sent();
                    return [2 /*return*/];
                case 5: return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                        data: JSON.stringify({
                            projectId: projectId,
                            type: types_1.PROJECT_FAILED,
                            payload: (_a = response.payload) !== null && _a !== void 0 ? _a : "initialization failed"
                        })
                    })];
                case 6:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function buildProject(projectId) {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    console.log("BUILD_PROJECT is being called");
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToControl, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_BUILD
                            })
                        })];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, waitForControl(projectId)];
                case 2:
                    response = _c.sent();
                    if (!(response.type === types_1.PROJECT_BUILD_SUCCESS)) return [3 /*break*/, 4];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_BUILD_SUCCESS
                            })
                        })];
                case 3:
                    _c.sent();
                    return [2 /*return*/];
                case 4:
                    if (!(response.type === types_1.PROJECT_BUILD_FAILED)) return [3 /*break*/, 6];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_BUILD_FAILED,
                                payload: (_a = response.payload) !== null && _a !== void 0 ? _a : ""
                            })
                        })];
                case 5:
                    _c.sent();
                    return [2 /*return*/];
                case 6:
                    if (!(response.type === types_1.PROJECT_FAILED)) return [3 /*break*/, 8];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_FAILED,
                                payload: (_b = response.payload) !== null && _b !== void 0 ? _b : ""
                            })
                        })];
                case 7:
                    _c.sent();
                    _c.label = 8;
                case 8: return [2 /*return*/];
            }
        });
    });
}
function runProject(projectId) {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToServing, "*", {
                        data: JSON.stringify({
                            projectId: projectId,
                            type: types_1.PROJECT_RUN
                        })
                    })];
                case 1:
                    _c.sent();
                    return [4 /*yield*/, waitForServer(projectId)];
                case 2:
                    response = _c.sent();
                    if (!(response.type === types_1.PROJECT_RUN_SUCCESS)) return [3 /*break*/, 4];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_RUN_SUCCESS
                            })
                        })];
                case 3:
                    _c.sent();
                    return [2 /*return*/];
                case 4:
                    if (!(response.type === types_1.PROJECT_RUN_FAILED)) return [3 /*break*/, 6];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_RUN_FAILED,
                                payload: (_a = response.payload) !== null && _a !== void 0 ? _a : ""
                            })
                        })];
                case 5:
                    _c.sent();
                    return [2 /*return*/];
                case 6:
                    if (!(response.type === types_1.PROJECT_FAILED)) return [3 /*break*/, 8];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROJECT_FAILED,
                                payload: (_b = response.payload) !== null && _b !== void 0 ? _b : ""
                            })
                        })];
                case 7:
                    _c.sent();
                    _c.label = 8;
                case 8: return [2 /*return*/];
            }
        });
    });
}
function handlePrompt(projectId, prompt) {
    return __awaiter(this, void 0, void 0, function () {
        var response;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToControl, "*", {
                        data: JSON.stringify({
                            projectId: projectId,
                            type: types_1.PROMPT,
                            payload: prompt
                        })
                    })];
                case 1:
                    _b.sent();
                    return [4 /*yield*/, waitForControl(projectId)];
                case 2:
                    response = _b.sent();
                    if (!(response.type === types_1.PROMPT_RESPONSE)) return [3 /*break*/, 4];
                    return [4 /*yield*/, redis.xAdd(types_1.OrchestatorToBackend, "*", {
                            data: JSON.stringify({
                                projectId: projectId,
                                type: types_1.PROMPT_RESPONSE,
                                payload: (_a = response.payload) !== null && _a !== void 0 ? _a : ""
                            })
                        })];
                case 3:
                    _b.sent();
                    _b.label = 4;
                case 4: return [2 /*return*/];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            ListenBackend();
            ListenControlPod();
            return [2 /*return*/];
        });
    });
}
main().catch(console.error);

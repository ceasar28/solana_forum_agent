import bodyParser from "body-parser";
import cors from "cors";
import express, { Request as ExpressRequest } from "express";
import multer, { File } from "multer";
import {
    elizaLogger,
    generateCaption,
    generateImage,
    generateText,
} from "@ai16z/eliza";
import { composeContext } from "@ai16z/eliza";
import { generateMessageResponse } from "@ai16z/eliza";
import { messageCompletionFooter } from "@ai16z/eliza";
import { AgentRuntime } from "@ai16z/eliza";
import {
    Content,
    Memory,
    ModelClass,
    Client,
    IAgentRuntime,
} from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";
import { settings } from "@ai16z/eliza";
import { createApiRouter } from "./api.ts";
import * as fs from "fs";
import * as path from "path";
import mongoose from "mongoose";
import { Post, Topic } from "./schema.ts";
import { postTopics } from "./postTopics.ts";
// import OpenAI from "openai";
const upload = multer({ storage: multer.memoryStorage() });

export const messageHandlerTemplate =
    // {{goals}}
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter;

// function getTwitterPostTemplate(words?: string[]) {
//     const twitterPostTemplate = `
// # Areas of Expertise
// {{knowledge}}

// # About {{agentName}} :
// {{bio}}
// {{lore}}
// {{topics}}

// {{providers}}

// {{characterPostExamples}}

// {{postDirections}}

// # Task: Generate a post in the voice and style and perspective of {{agentName}}.
// Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Do not add commentary or acknowledge this request, just write the post.
// Your response should not contain any questions. Brief, concise statements only. The total character count MUST be less than 280. No emojis.
// Your response should not start with any of the word or letter in this array ${words}`;
//     return twitterPostTemplate;
// }

function getForumPostTemplate(topic: string, posts?: any[]): string {
    const postsList =
        posts && posts.length > 0
            ? posts.join(", ")
            : "No similar posts provided";

    const forumPostTemplate = `# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

# Task:
Please write a detailed post about ${topic} in **HTML format** only. The post must be structured using proper HTML tags such as <h1>, <h2>, <p>, <ul>, <li>, etc. Do **not** use \`\\n\`, \`\\n\\n\`, or any newline characters. Each paragraph should be enclosed in \`<p></p>\` tags, and list items should be inside \`<ul><li></li></ul>\` tags. Ensure the content is clean, with no extra newlines or spaces between tags. also don't user <!DOCTYPE html>,<html lang="en">,<head> and <title> tage

Additionally, the post must be original and should not be similar to any of the posts listed here: ${postsList}.`;

    return forumPostTemplate;
}

// const MAX_TWEET_LENGTH = 280;

// function truncateToCompleteSentence(text: string): string {
//     if (text.length <= MAX_TWEET_LENGTH) {
//         return text;
//     }

//     // Attempt to truncate at the last period within the limit
//     const truncatedAtPeriod = text.slice(
//         0,
//         text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
//     );
//     if (truncatedAtPeriod.trim().length > 0) {
//         return truncatedAtPeriod.trim();
//     }

//     // If no period is found, truncate to the nearest whitespace
//     const truncatedAtSpace = text.slice(
//         0,
//         text.lastIndexOf(" ", MAX_TWEET_LENGTH)
//     );
//     if (truncatedAtSpace.trim().length > 0) {
//         return truncatedAtSpace.trim() + "...";
//     }

//     // Fallback: Hard truncate and add ellipsis
//     return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
// }

// function getFirstWord(sentence) {
//     if (typeof sentence !== "string" || sentence.trim() === "") {
//         throw new Error("Input must be a non-empty string.");
//     }
//     // Remove punctuation and trim the sentence
//     const cleanedSentence = sentence.trim().replace(/^[^\w]*|[^\w]*$/g, "");
//     return cleanedSentence.split(/\s+/)[0];
// }

// Function to pick a random unused topic
async function getRandomUnusedTopic() {
    try {
        // Fetch all posts and their topics
        const allPosts = await Post.find({}, "topic");
        const usedTopics = allPosts.map((post) => post.topic);

        // Fetch the topics array from the Topic collection
        const topicDocument = await Topic.findOne({}, "topics");
        if (!topicDocument || !topicDocument.topics) {
            throw new Error("No topics found in the database.");
        }

        const availableTopics = topicDocument.topics;

        // Filter out used topics
        const unusedTopics = availableTopics.filter(
            (topic) => !usedTopics.includes(topic)
        );

        if (unusedTopics.length === 0) {
            throw new Error("No unused topics available.");
        }

        // Pick a random unused topic
        const randomTopic =
            unusedTopics[Math.floor(Math.random() * unusedTopics.length)];

        return randomTopic;
    } catch (error) {
        console.error("Error fetching random unused topic:", error.message);
        throw error;
    }
}

function stripHtmlCodeBlock(content) {
    // Remove the "```html" at the beginning and "```" at the end
    return content.replace(/^```html\s*|\s*```$/g, "");
}

export interface SimliClientConfig {
    apiKey: string;
    faceID: string;
    handleSilence: boolean;
    videoRef: any;
    audioRef: any;
}
export class DirectClient {
    public app: express.Application;
    private agents: Map<string, AgentRuntime>;
    private server: any; // Store server instance

    constructor() {
        elizaLogger.log("DirectClient constructor");
        this.app = express();
        this.app.use(cors());
        this.agents = new Map();

        this.app.use(bodyParser.json());
        this.app.use(bodyParser.urlencoded({ extended: true }));

        const apiRouter = createApiRouter(this.agents);
        this.app.use(apiRouter);

        // Define an interface that extends the Express Request interface
        interface CustomRequest extends ExpressRequest {
            file: File;
        }

        // Update the route handler to use CustomRequest instead of express.Request
        this.app.post(
            "/:agentId/whisper",
            upload.single("file"),
            async (req: CustomRequest, res: express.Response) => {
                const audioFile = req.file; // Access the uploaded file using req.file
                const agentId = req.params.agentId;

                if (!audioFile) {
                    res.status(400).send("No audio file provided");
                    return;
                }

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const formData = new FormData();
                const audioBlob = new Blob([audioFile.buffer], {
                    type: audioFile.mimetype,
                });
                formData.append("file", audioBlob, audioFile.originalname);
                formData.append("model", "whisper-1");

                const response = await fetch(
                    "https://api.openai.com/v1/audio/transcriptions",
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${runtime.token}`,
                        },
                        body: formData,
                    }
                );

                const data = await response.json();
                res.json(data);
            }
        );

        this.app.post(
            "/:agentId/message",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );
                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    req.body.userName,
                    req.body.name,
                    "direct"
                );

                const text = req.body.text;
                const messageId = stringToUuid(Date.now().toString());

                const content: Content = {
                    text,
                    attachments: [],
                    source: "direct",
                    inReplyTo: undefined,
                };

                const userMessage = {
                    content,
                    userId,
                    roomId,
                    agentId: runtime.agentId,
                };

                const memory: Memory = {
                    id: messageId,
                    agentId: runtime.agentId,
                    userId,
                    roomId,
                    content,
                    createdAt: Date.now(),
                };

                await runtime.messageManager.createMemory(memory);

                const state = await runtime.composeState(userMessage, {
                    agentName: runtime.character.name,
                });

                const context = composeContext({
                    state,
                    template: messageHandlerTemplate,
                });

                const response = await generateMessageResponse({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.SMALL,
                });

                // save response to memory
                const responseMessage = {
                    ...userMessage,
                    userId: runtime.agentId,
                    content: response,
                };

                await runtime.messageManager.createMemory(responseMessage);

                if (!response) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }

                let message = null as Content | null;

                await runtime.evaluate(memory, state);

                const _result = await runtime.processActions(
                    memory,
                    [responseMessage],
                    state,
                    async (newMessages) => {
                        message = newMessages;
                        return [memory];
                    }
                );

                if (message) {
                    res.json([response, message]);
                } else {
                    res.json([response]);
                }
            }
        );

        this.app.post(
            "/:agentId/image",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const agent = this.agents.get(agentId);
                if (!agent) {
                    res.status(404).send("Agent not found");
                    return;
                }

                const images = await generateImage({ ...req.body }, agent);
                const imagesRes: { image: string; caption: string }[] = [];
                if (images.data && images.data.length > 0) {
                    for (let i = 0; i < images.data.length; i++) {
                        const caption = await generateCaption(
                            { imageUrl: images.data[i] },
                            agent
                        );
                        imagesRes.push({
                            image: images.data[i],
                            caption: caption.title,
                        });
                    }
                }
                res.json({ images: imagesRes });
            }
        );

        this.app.post(
            "/fine-tune",
            async (req: express.Request, res: express.Response) => {
                try {
                    const response = await fetch(
                        "https://api.bageldb.ai/api/v1/asset",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                            body: JSON.stringify(req.body),
                        }
                    );

                    const data = await response.json();
                    res.json(data);
                } catch (error) {
                    res.status(500).json({
                        error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
                        details: error.message,
                    });
                }
            }
        );
        this.app.get(
            "/fine-tune/:assetId",
            async (req: express.Request, res: express.Response) => {
                const assetId = req.params.assetId;
                const downloadDir = path.join(
                    process.cwd(),
                    "downloads",
                    assetId
                );

                console.log("Download directory:", downloadDir);

                try {
                    console.log("Creating directory...");
                    await fs.promises.mkdir(downloadDir, { recursive: true });

                    console.log("Fetching file...");
                    const fileResponse = await fetch(
                        `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
                        {
                            headers: {
                                "X-API-KEY": `${process.env.BAGEL_API_KEY}`,
                            },
                        }
                    );

                    if (!fileResponse.ok) {
                        throw new Error(
                            `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
                        );
                    }

                    console.log("Response headers:", fileResponse.headers);

                    const fileName =
                        fileResponse.headers
                            .get("content-disposition")
                            ?.split("filename=")[1]
                            ?.replace(/"/g, "") || "default_name.txt";

                    console.log("Saving as:", fileName);

                    const arrayBuffer = await fileResponse.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);

                    const filePath = path.join(downloadDir, fileName);
                    console.log("Full file path:", filePath);

                    await fs.promises.writeFile(filePath, buffer);

                    // Verify file was written
                    const stats = await fs.promises.stat(filePath);
                    console.log(
                        "File written successfully. Size:",
                        stats.size,
                        "bytes"
                    );

                    res.json({
                        success: true,
                        message: "Single file downloaded successfully",
                        downloadPath: downloadDir,
                        fileCount: 1,
                        fileName: fileName,
                        fileSize: stats.size,
                    });
                } catch (error) {
                    console.error("Detailed error:", error);
                    res.status(500).json({
                        error: "Failed to download files from BagelDB",
                        details: error.message,
                        stack: error.stack,
                    });
                }
            }
        );
        // this.app.get(
        //     "/:agentId/reddit",
        //     async (req: express.Request, res: express.Response) => {
        //         const agentId = req.params.agentId;
        //         const roomId = stringToUuid(
        //             req.body.roomId ?? "default-room-" + agentId
        //         );

        //         const userId = stringToUuid(req.body.userId ?? "user");

        //         let runtime = this.agents.get(agentId);

        //         // if runtime is null, look for runtime with the same name
        //         if (!runtime) {
        //             runtime = Array.from(this.agents.values()).find(
        //                 (a) =>
        //                     a.character.name.toLowerCase() ===
        //                     agentId.toLowerCase()
        //             );
        //         }

        //         if (!runtime) {
        //             res.status(404).send("Agent not found");
        //             return;
        //         }

        //         await runtime.ensureConnection(
        //             userId,
        //             roomId,
        //             "tweetAgent",
        //             "agent",
        //             "direct"
        //         );

        //         const messageId = stringToUuid(Date.now().toString());

        //         // startedcbcbbcb
        //         const topics = runtime.character.topics.join(", ");

        //         const state = await runtime.composeState(
        //             {
        //                 userId: runtime.agentId,
        //                 roomId: roomId,
        //                 agentId: runtime.agentId,
        //                 content: {
        //                     text: topics,
        //                     action: "",
        //                 },
        //             },
        //             {
        //                 agentName: runtime.character.name,
        //                 bio: runtime.character.bio,
        //             }
        //         );

        //         // find all first word
        //         const allFirstWords = await Word.find();
        //         // Extract the first word of each existing post
        //         const existingFirstWords = allFirstWords.map((t) => t.word);

        //         const twitterPostTemplate =
        //             getTwitterPostTemplate(existingFirstWords);
        //         const context = composeContext({
        //             state,
        //             template:
        //                 runtime.character.templates?.twitterPostTemplate ||
        //                 twitterPostTemplate,
        //         });

        //         elizaLogger.debug("generate post prompt:\n" + context);

        //         const newTweetContent = await generateText({
        //             runtime: runtime,
        //             context,
        //             modelClass: ModelClass.SMALL,
        //         });

        //         // Replace \n with proper line breaks and trim excess spaces
        //         const formattedTweet = newTweetContent
        //             .replaceAll(/\\n/g, "\n")
        //             .trim();

        //         // Use the helper function to truncate to complete sentence
        //         const tweet = truncateToCompleteSentence(formattedTweet);

        //         await runtime.ensureRoomExists(roomId);
        //         await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

        //         await runtime.messageManager.createMemory({
        //             id: messageId,
        //             userId: runtime.agentId,
        //             agentId: runtime.agentId,
        //             content: {
        //                 text: newTweetContent.trim(),
        //                 source: "twitter",
        //             },
        //             roomId,
        //             createdAt: Date.now(),
        //         });

        //         if (existingFirstWords.length >= 20) {
        //             await Word.deleteMany();

        //             const firstWord = getFirstWord(tweet);

        //             const newTweetFirstWord = new Word({ word: firstWord });
        //             await newTweetFirstWord.save();
        //         } else {
        //             const firstWord = getFirstWord(tweet);
        //             const newTweetFirstWord = new Word({ word: firstWord });
        //             await newTweetFirstWord.save();
        //         }

        //         if (!tweet) {
        //             res.status(500).send(
        //                 "No response from generateMessageResponse"
        //             );
        //             return;
        //         }

        //         res.json({ redditPost: tweet });
        //     }
        // );

        this.app.get(
            "/:agentId/forum-post",
            async (req: express.Request, res: express.Response) => {
                const agentId = req.params.agentId;
                const roomId = stringToUuid(
                    req.body.roomId ?? "default-room-" + agentId
                );

                const userId = stringToUuid(req.body.userId ?? "user");

                let runtime = this.agents.get(agentId);

                // if runtime is null, look for runtime with the same name
                if (!runtime) {
                    runtime = Array.from(this.agents.values()).find(
                        (a) =>
                            a.character.name.toLowerCase() ===
                            agentId.toLowerCase()
                    );
                }

                if (!runtime) {
                    res.status(404).send("Agent not found");
                    return;
                }

                await runtime.ensureConnection(
                    userId,
                    roomId,
                    "tweetAgent",
                    "agent",
                    "direct"
                );

                const messageId = stringToUuid(Date.now().toString());

                const topics = runtime.character.topics.join(", ");

                const state = await runtime.composeState(
                    {
                        userId: runtime.agentId,
                        roomId: roomId,
                        agentId: runtime.agentId,
                        content: {
                            text: topics,
                            action: "",
                        },
                    },
                    {
                        agentName: runtime.character.name,
                        bio: runtime.character.bio,
                    }
                );

                // find all first word
                const allPosts = await Post.find();
                const randomTopic = await getRandomUnusedTopic();

                const blogPostTemplate = getForumPostTemplate(
                    randomTopic,
                    allPosts
                );
                const context = composeContext({
                    state,
                    template: blogPostTemplate,
                });

                elizaLogger.debug("generate post prompt:\n" + context);

                const newBlogContent = await generateText({
                    runtime: runtime,
                    context,
                    modelClass: ModelClass.SMALL,
                });
                const formatBlog = stripHtmlCodeBlock(newBlogContent);

                await runtime.ensureRoomExists(roomId);
                await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

                await runtime.messageManager.createMemory({
                    id: messageId,
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    content: {
                        text: formatBlog.trim(),
                    },
                    roomId,
                    createdAt: Date.now(),
                });

                if (allPosts.length >= 500) {
                    await Post.deleteMany();

                    const newBlog = new Post({
                        post: formatBlog,
                        topic: randomTopic,
                    });
                    await newBlog.save();
                } else {
                    const newBlog = new Post({
                        post: formatBlog,
                        topic: randomTopic,
                    });
                    await newBlog.save();
                }

                if (!newBlogContent) {
                    res.status(500).send(
                        "No response from generateMessageResponse"
                    );
                    return;
                }
                console.log("content  :", newBlogContent);
                res.json({
                    forumPost: newBlogContent,
                });
            }
        );
        this.app.get("/ping", (req: express.Request, res: express.Response) => {
            res.json({
                success: true,
                message: "Server is alive and running!",
            });
        });
    }

    public registerAgent(runtime: AgentRuntime) {
        this.agents.set(runtime.agentId, runtime);
    }

    public unregisterAgent(runtime: AgentRuntime) {
        this.agents.delete(runtime.agentId);
    }

    public start(port: number) {
        this.server = this.app.listen(port, async () => {
            const mongoURI = process.env.MONGO_URI; // Or use a MongoDB Atlas URI

            // Connect to MongoDB
            mongoose
                .connect(mongoURI)
                .then(() => {
                    console.log("MongoDB connected");
                })
                .catch((err) => {
                    console.error("MongoDB connection error:", err);
                });

            await Topic.deleteMany();

            const newTweetFirstWord = new Topic({
                topics: postTopics,
            });
            await newTweetFirstWord.save();
            elizaLogger.success(`Server running at http://localhost:${port}/`);
        });

        // Handle graceful shutdown
        const gracefulShutdown = () => {
            elizaLogger.log("Received shutdown signal, closing server...");
            this.server.close(() => {
                elizaLogger.success("Server closed successfully");
                process.exit(0);
            });

            // Force close after 5 seconds if server hasn't closed
            setTimeout(() => {
                elizaLogger.error(
                    "Could not close connections in time, forcefully shutting down"
                );
                process.exit(1);
            }, 5000);
        };

        // Handle different shutdown signals
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGINT", gracefulShutdown);
    }

    public stop() {
        if (this.server) {
            this.server.close(() => {
                elizaLogger.success("Server stopped");
            });
        }
    }
}

export const DirectClientInterface: Client = {
    start: async (_runtime: IAgentRuntime) => {
        elizaLogger.log("DirectClientInterface start");
        const client = new DirectClient();
        const serverPort = parseInt(settings.SERVER_PORT || "3000");
        client.start(serverPort);
        return client;
    },
    stop: async (_runtime: IAgentRuntime, client?: any) => {
        if (client instanceof DirectClient) {
            client.stop();
        }
    },
};

export default DirectClientInterface;

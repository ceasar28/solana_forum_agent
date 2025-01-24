import mongoose, { Schema } from "mongoose";

const PostSchema = new Schema(
    {
        post: {
            type: String,
            required: true,
        },
        topic: String,
    },
    { timestamps: true }
);

const Post = mongoose.model("Post", PostSchema);

export { Post };

const TopicSchema = new Schema(
    {
        topics: {
            type: [String],
            required: true,
        },
    },
    { timestamps: true }
); // Optional: Adds createdAt and updatedAt fields

// Create the Tweet model
const Topic = mongoose.model("Topic", TopicSchema);

export { Topic };

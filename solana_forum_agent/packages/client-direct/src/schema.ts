import mongoose, { Schema } from "mongoose";

// Define the Tweet schema
const WordSchema = new Schema(
    {
        word: {
            type: String,
            required: true,
        },
    },
    { timestamps: true }
); // Optional: Adds createdAt and updatedAt fields

// Create the Tweet model
const Word = mongoose.model("Word", WordSchema);

export { Word };

// bf42dee9-b13f-0b9a-9cc9-7e98770dd2a9

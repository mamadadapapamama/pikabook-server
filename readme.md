# 📑 Project Refactoring Specification: Pikabook

## 1. Core Objective
Refactor the Firestore data structure to improve scalability and support multi-language dynamic translations (KO, EN).

## 2. Key Architecture Shift: Sub-collections
Instead of storing all text data in a single array inside the `Page` document, move to a **sub-collection** model.
- **Path**: `notes/{noteId}/pages/{pageId}/segments/{segmentId}`
- **Reason**: Prevent 1MB document size limit and allow granular data management.

## 3. Segment Document Schema
Each document in the `segments` sub-collection must contain:
```json
{
  "index": number,              // Order of the segment
  "segmentType": "string",      // 'sentence', 'paragraph', 'header', 'quiz', etc.
  "originalText": "string",     // Source text (e.g., Chinese)
  "pinyin": "string",           // Pinyin for Chinese
  "translatedText": "string",   // Translation in the user's SELECTED target language
  "targetLanguage": "string",   // Language code of translatedText (e.g., 'ko', 'en')
  "updatedAt": timestamp
}
```

## 4. LLM Prompt Requirements
- **Dynamic Translation**: Support translation into the user's chosen language (Target Language).
- **Dual Mode Support**:
    - **Sentence Mode**: Map OCR-provided segments to individual documents.
    - **Paragraph Mode**: Intelligent segmentation by LLM into types (Title, Quiz, Body, etc.).

## 5. UI & Compatibility
- **UI Binding**: Dynamically render widgets based on the `segmentType` field.
- **Backward Compatibility**: Implement fallback logic to read from the legacy `processedText` array if the `segments` sub-collection is empty.

---
*Created on 2026-01-23 for context transfer to `pikabook-server`.*

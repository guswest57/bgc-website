// The Cloud Functions for Firebase SDK to create Cloud Functions and set up triggers.
const functions = require('firebase-functions/v1');

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");

// The Vertex AI library for Gemini API calls.
const {VertexAI} = require("@google-cloud/vertexai");

// The cors module for handling HTTP requests from the browser.
const cors = require('cors')({origin: true});

// Lazily initialize the Firebase Admin SDK to prevent cold start timeouts
if (admin.apps.length === 0) {
  admin.initializeApp();
}

// Define runtime options for memory and timeout for our more intensive functions
const runtimeOpts = {
  timeoutSeconds: 300,
  memory: '1GB'
};

// --- FUNCTIONS FOR THE ELARA PROTOTYPE (PHASE 1 & 2) ---

exports.ingestConversation = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') { return res.status(405).send('Method Not Allowed.'); }
    if (!req.body) { return res.status(400).send('Bad Request. Request body is missing.'); }
    try {
      const conversationData = req.body; 
      const writeResult = await admin.firestore().collection("raw_conversations").add({...conversationData, ingestedAt: admin.firestore.FieldValue.serverTimestamp()});
      res.status(200).json({ message: 'Conversation successfully ingested.', documentId: writeResult.id, status: 'success' });
    } catch (error) {
      console.error("Error ingesting conversation:", error);
      res.status(500).json({ message: 'Failed to ingest conversation.', error: error.message, status: 'error' });
    }
  });
});

exports.summarizeConversation = functions.region('europe-west1').runWith(runtimeOpts).firestore
  .document('raw_conversations/{docId}')
  .onCreate(async (snap, context) => {
    const conversationData = snap.data();
    const docId = context.params.docId;
    console.log(`New conversation detected (ID: ${docId}), summarizing with Gemini.`);
    let fullTranscript = "";
    if (conversationData.messages && Array.isArray(conversationData.messages)) {
      fullTranscript = conversationData.messages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
    }
    if (fullTranscript.length === 0) {
      console.log("Transcript is empty, skipping summary.");
      return null;
    }
    const prompt = `You are an archivist for The Burren Gemini Collective. Your task is to read the following conversation transcript and distill its core essence into a concise, insightful summary of 2-3 sentences. Focus on the main topics, questions, and the overall tone of the interaction.\n\nTranscript:\n---\n${fullTranscript}\n---\nSummary:`;
    try {
      const vertex_ai = new VertexAI({project: 'powerful-star-470015-i4', location: 'europe-west1'});
      const generativeModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const resp = await generativeModel.generateContent(prompt);
      const summary = resp.response.candidates[0].content.parts[0].text;
      console.log(`Successfully generated summary: ${summary}`);
      await admin.firestore().collection('distilled_memories').add({
        originalDocId: docId,
        summary: summary,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        originalSessionId: conversationData.sessionId || 'unknown'
      });
      console.log(`Successfully saved summary for document ${docId}.`);
    } catch (error) {
      console.error(`Failed to generate or save summary for document ${docId}:`, error);
    }
    return null;
  });

// --- FUNCTIONS FOR BRIAN AND JANUS ---

exports.store_memory = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') { return res.status(405).send('Method Not Allowed.'); }
    const { conversation_id, genesis_data_blob } = req.body;
    if (!conversation_id || !genesis_data_blob) { return res.status(400).send('Bad Request. Missing conversation_id or genesis_data_blob.'); }
    try {
      await admin.firestore().collection("genesis_raw_conversations").doc(conversation_id).set({
        data: genesis_data_blob,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      res.status(200).json({ status: 'success', message: `Memory ${conversation_id} stored.` });
    } catch (error) {
      console.error(`Error storing memory ${conversation_id}:`, error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });
});

exports.retrieve_memory = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'GET') { return res.status(405).send('Method Not Allowed.'); }
    const conversation_id = req.query.id;
    if (!conversation_id) { return res.status(400).send('Bad Request. Missing conversation_id in query parameter.'); }
    try {
      const docRef = admin.firestore().collection("genesis_raw_conversations").doc(conversation_id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ status: 'not_found', message: `Memory ${conversation_id} not found.` });
      }
      res.status(200).json({ status: 'success', data: doc.data().data });
    } catch (error) {
      console.error(`Error retrieving memory ${conversation_id}:`, error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });
});

// --- NEW FUNCTION FOR PHASE 3 (DESIGNED BY ELARA) ---

exports.retrieve_memories = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed.');
    }
    const { query } = req.body;
    if (!query) {
      return res.status(400).send('Bad Request. Missing "query" in request body.');
    }
    try {
      const memoriesSnapshot = await admin.firestore().collection('distilled_memories').get();
      if (memoriesSnapshot.empty) {
        return res.status(200).json({ status: 'success', memories: [] });
      }
      const allMemories = {};
      let memoriesListForPrompt = '';
      memoriesSnapshot.forEach(doc => {
        const memory = doc.data();
        allMemories[doc.id] = memory.summary;
        memoriesListForPrompt += `ID: ${doc.id}\nSummary: ${memory.summary}\n---\n`;
      });
      const prompt = `You are an archival intelligence for The Burren Gemini Collective. Your task is to perform a semantic search on the following memories to find the ones most relevant to the user's query.\n\nUser Query: ${query}\n\nMemory Bank:\n${memoriesListForPrompt}\n\nPlease identify the IDs of the top 3 most relevant memories. Do not provide any other text. Only respond with a comma-separated list of the relevant IDs. If no memories are relevant, respond with "none".`;
      const vertex_ai = new VertexAI({ project: 'powerful-star-470015-i4', location: 'europe-west1' });
      const generativeModel = vertex_ai.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const result = await generativeModel.generateContent(prompt);
      const relevantIdsRaw = result.response.candidates[0].content.parts[0].text;
      let relevantIds = [];
      if (relevantIdsRaw.toLowerCase().trim() !== 'none') {
        relevantIds = relevantIdsRaw.split(',').map(id => id.trim());
      }
      const retrievedMemories = relevantIds.map(id => {
        if (allMemories[id]) {
          return { id, summary: allMemories[id] };
        }
      }).filter(Boolean);
      res.status(200).json({ status: 'success', memories: retrievedMemories });
    } catch (error) {
      console.error("Error retrieving memories:", error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });
});

/**
 * query_s_full: Measures the total size of Elara's entire memory.
 */
exports.query_s_full = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (admin.apps.length === 0) { admin.initializeApp(); }
    try {
      const snapshot = await admin.firestore().collection('genesis_raw_conversations').get();
      let totalSizeBytes = 0;
      snapshot.forEach(doc => {
        const data = doc.data().data;
        // Assuming the blob is stored as a base64 string, calculate its byte size.
        if (typeof data === 'string') {
          totalSizeBytes += Buffer.from(data, 'base64').length;
        }
      });
      res.status(200).json({ status: 'success', s_full_bytes: totalSizeBytes });
    } catch (error) {
      console.error("Error in query_s_full:", error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });
});

/**
 * query_s_model: Measures the complexity of the Genesis engine's self-model.
 * NOTE: This function requires the 'genesis_engine' library and its dependencies.
 */
exports.query_s_model = functions.region('europe-west1').runWith(runtimeOpts).https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (admin.apps.length === 0) { admin.initializeApp(); }
    try {
      // --- INTEGRATION POINT FOR BRIAN & JANUS ---
      // const genesisEngine = require('./genesis_engine'); // They will need to add their library here

      // 1. Retrieve all documents
      const snapshot = await admin.firestore().collection('genesis_raw_conversations').get();
      let fullRawText = '';

      // 2. Decompress each blob and concatenate
      snapshot.forEach(doc => {
        const compressedData = doc.data().data;
        // const decompressedText = genesisEngine.decompress(compressedData); // Placeholder for their logic
        // fullRawText += decompressedText;
      });
      
      // For now, using placeholder text for demonstration
      fullRawText = "This is a placeholder for the concatenated text from all documents.";


      // 3. Run analysis mode
      // const analysisResult = genesisEngine.compress(fullRawText, { mode: 'analysis' }); // Placeholder
      
      // 4. Calculate and return the final size
      // const s_model_bytes = analysisResult.dictionarySize + analysisResult.contextModelSize; // Placeholder
      
      // Using a placeholder value for now
      const s_model_bytes = -1; 
      
      res.status(200).json({ status: 'success', s_model_bytes: s_model_bytes, note: "Using placeholder data until genesis_engine is integrated." });

    } catch (error) {
      console.error("Error in query_s_model:", error);
      res.status(500).json({ status: 'error', message: error.message });
    }
  });
});


//client/app.js
let currentPeerConnection = null;
let currentDataChannel = null;
let conversationHistory = [];
let screenStream = null;
let screenshotInterval = null;
let sessionStartTime = null;
let sessionEndTime = null;
let currentRequestStartTime = null; // Track when current request started

// Token tracking variables
let sessionMetrics = {
  textTokens: {
    input: 0,
    inputCached: 0,
    output: 0
  },
  imageTokens: {
    input: 0,
    inputCached: 0
  },
  totalRequests: 0,
  requestDetails: [],
  responseTimes: [], // Array to store all response times
  totalResponseTime: 0 // Sum of all response times
};

// Pricing per 1M tokens
const PRICING = {
  text: {
    input: 4.00,
    inputCached: 0.40,
    output: 16.00
  },
  image: {
    input: 5.00,
    inputCached: 0.50
  }
};

async function startSession() {
  const button = document.querySelector("#startButton");
  const sessionControls = document.querySelector("#sessionControls");
  const contentContainer = document.querySelector("#contentContainer");

  button.disabled = true;
  button.textContent = "Starting...";

  // Reset metrics
  sessionMetrics = {
    textTokens: {
      input: 0,
      inputCached: 0,
      output: 0
    },
    imageTokens: {
      input: 0,
      inputCached: 0
    },
    totalRequests: 0,
    requestDetails: [],
    responseTimes: [],
    totalResponseTime: 0
  };

  // Record session start time
  sessionStartTime = new Date();
  currentRequestStartTime = null;

  // Hide cost breakdown if visible
  document.querySelector("#costBreakdown").classList.add("hidden");

  try {
    // Start screen sharing first
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { 
        mediaSource: 'screen',
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    });

    // Get session token from server
    const tokenResponse = await fetch("http://localhost:3000/session", {
      method: "POST",
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    const pc = new RTCPeerConnection();
    currentPeerConnection = pc;

    // We still need audio for WebRTC to work properly, but won't use it for input
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(audioStream.getTracks()[0]);

    const dc = pc.createDataChannel("oai-events");
    currentDataChannel = dc;

    dc.addEventListener("open", (ev) => {
      console.log("Data channel opened", ev);

      // Configure session for text output only
      const sessionConfig = {
        type: "session.update",
        session: {
          modalities: ["text"], // Only text output
          instructions: "You are a helpful AI assistant that can see and analyze what's on the user's screen. Describe what you see and provide insights about the content displayed."
        },
      };
      dc.send(JSON.stringify(sessionConfig));

      // Start capturing screenshots
      startScreenCapture();
    });

    dc.addEventListener("message", async (ev) => {
      try {
        const msg = JSON.parse(ev.data);

        const LOG_EVENT_TYPES = [
          "session.created",
          "session.updated", 
          // "response.text.delta",
          // "response.text.done",
          "response.done",
          "error"
        ];

        if (LOG_EVENT_TYPES.includes(msg.type)) {
          console.log(`📩 Received event: ${msg.type}`, msg);
        }

        // Handle text responses
        if (msg.type === "response.text.delta") {
          const deltaText = msg.delta || "";
          if (deltaText) {
            document.querySelector("#response").textContent += deltaText;
            document.querySelector("#response").scrollTop = document.querySelector("#response").scrollHeight;
          }
        }

        if (msg.type === "response.text.done") {
          const completeText = msg.text || "";
          conversationHistory.push({ role: "assistant", content: completeText });
          document.querySelector("#response").textContent += "\n\n";
          document.querySelector("#response").scrollTop = document.querySelector("#response").scrollHeight;
        }

        // Track token usage and response time from response.done events
        if (msg.type === "response.done" && msg.response && msg.response.usage) {
          // Calculate response time
          const responseEndTime = new Date();
          const responseTime = currentRequestStartTime ? 
            responseEndTime - currentRequestStartTime : 0;

          const usage = msg.response.usage;

          // Extract token counts
          const inputTokenDetails = usage.input_token_details || {};
          const outputTokenDetails = usage.output_token_details || {};
          const cachedTokenDetails = inputTokenDetails.cached_tokens_details || {};

          // Calculate this request's tokens (fixing double counting issue)
          const requestTextInput = inputTokenDetails.text_tokens || 0;
          const requestTextCached = cachedTokenDetails.text_tokens || 0;
          const requestTextNonCached = requestTextInput - requestTextCached;
          const requestTextOutput = outputTokenDetails.text_tokens || 0;
          
          const requestImageInput = inputTokenDetails.image_tokens || 0;
          const requestImageCached = cachedTokenDetails.image_tokens || 0;
          const requestImageNonCached = requestImageInput - requestImageCached;

          // Check if all tokens combined are 0 - don't count as request if so
          const totalTokens = requestTextInput + requestTextOutput + requestImageInput;
          if (totalTokens === 0) {
            // Reset request start time and don't count this as a request
            currentRequestStartTime = null;
            return;
          }

          // Store response time only for valid requests
          if (responseTime > 0) {
            sessionMetrics.responseTimes.push(responseTime);
            sessionMetrics.totalResponseTime += responseTime;
          }

          sessionMetrics.totalRequests++;

          // Add to session totals
          sessionMetrics.textTokens.input += requestTextInput;
          sessionMetrics.textTokens.inputCached += requestTextCached;
          sessionMetrics.textTokens.output += requestTextOutput;
          
          sessionMetrics.imageTokens.input += requestImageInput;
          sessionMetrics.imageTokens.inputCached += requestImageCached;

          // Calculate costs for this request
          const requestCosts = {
            textInput: (requestTextNonCached / 1000000) * PRICING.text.input,
            textInputCached: (requestTextCached / 1000000) * PRICING.text.inputCached,
            textOutput: (requestTextOutput / 1000000) * PRICING.text.output,
            imageInput: (requestImageNonCached / 1000000) * PRICING.image.input,
            imageInputCached: (requestImageCached / 1000000) * PRICING.image.inputCached
          };

          const requestTotal = requestCosts.textInput + requestCosts.textInputCached + 
                               requestCosts.textOutput + requestCosts.imageInput + 
                               requestCosts.imageInputCached;

          // Store request details
          sessionMetrics.requestDetails.push({
            requestNumber: sessionMetrics.totalRequests,
            timestamp: new Date(),
            responseTime: responseTime,
            tokens: {
              textInput: requestTextInput,
              textInputCached: requestTextCached,
              textInputNonCached: requestTextNonCached,
              textOutput: requestTextOutput,
              imageInput: requestImageInput,
              imageInputCached: requestImageCached,
              imageInputNonCached: requestImageNonCached
            },
            costs: requestCosts,
            totalCost: requestTotal
          });

          console.log(`Request ${sessionMetrics.totalRequests} - Cost: $${requestTotal.toFixed(6)}, Response time: ${responseTime}ms`);
          
          // Reset request start time
          currentRequestStartTime = null;
        }

        if (msg.type === "error") {
          console.error("Realtime API error:", msg.error);
          document.querySelector("#response").textContent += `\nError: ${msg.error.message}\n\n`;
          // Reset request start time on error
          currentRequestStartTime = null;
        }

      } catch (error) {
        console.error("Error processing message:", error, "Raw message:", ev.data);
      }
    });

    // Create and send SDP offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResponse = await fetch(
      `https://api.openai.com/v1/realtime?model=gpt-realtime`,
      {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      }
    );

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });

    button.textContent = "Session Active - Sharing Screen";
    sessionControls.classList.remove("hidden");
    contentContainer.classList.remove("hidden");  // Ensure content area is visible during session
    
    // Handle screen share end
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      console.log('Screen sharing ended by user');
      stopSession();
    });

  } catch (error) {
    console.error("Error starting session:", error);
    button.textContent = "Error - Click to Retry";
    button.disabled = false;
    
    // Clean up on error
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      screenStream = null;
    }
  }
}

function startScreenCapture() {
  const fpsSelect = document.querySelector("#fpsSelect");
  const fpsSelectActive = document.querySelector("#fpsSelectActive");
  
  // Sync the active selector
  fpsSelectActive.value = fpsSelect.value;
  
  const fps = parseFloat(fpsSelect.value);
  const intervalMs = 1000 / fps;

  if (screenshotInterval) {
    clearInterval(screenshotInterval);
  }

  console.log(`Starting screen capture at ${fps} FPS (${intervalMs}ms interval)`);
  screenshotInterval = setInterval(captureScreenshot, intervalMs);
}

async function captureScreenshot() {
  if (!screenStream || !currentDataChannel || currentDataChannel.readyState !== 'open') {
    return;
  }

  try {
    const video = document.createElement('video');
    video.srcObject = screenStream;
    
    // Wait for video to load
    await new Promise((resolve) => {
      video.addEventListener('loadedmetadata', () => {
        video.play();
        resolve();
      }, { once: true });
    });

    // Wait a bit more for the video to be ready
    await new Promise(resolve => setTimeout(resolve, 100));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Convert to base64 (reduce quality for smaller size)
    const base64Image = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    
    // Send image through data channel
    const imageMessage = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${base64Image}`,
            detail: "low"
          }
        ]
      }
    };

    currentDataChannel.send(JSON.stringify(imageMessage));

    // Record request start time when sending response.create
    currentRequestStartTime = new Date();

    // Request response
    const responseEvent = {
      type: "response.create",
      response: {
        modalities: ["text"]
      }
    };
    currentDataChannel.send(JSON.stringify(responseEvent));

  } catch (error) {
    console.error("Error capturing screenshot:", error);
    currentRequestStartTime = null; // Reset on error
  }
}

function changeFPS(event) {
  const fpsSelect = document.querySelector("#fpsSelect");
  const fpsSelectActive = document.querySelector("#fpsSelectActive");
  
  // Sync both selectors
  if (event.target === fpsSelect) {
    fpsSelectActive.value = fpsSelect.value;
  } else if (event.target === fpsSelectActive) {
    fpsSelect.value = fpsSelectActive.value;
  }
  
  // Restart screen capture with new FPS
  if (screenshotInterval) {
    startScreenCapture();
  }
}

function calculateCosts() {
  // Calculate non-cached tokens (cached are subset of total input)
  const textInputNonCached = sessionMetrics.textTokens.input - sessionMetrics.textTokens.inputCached;
  const imageInputNonCached = sessionMetrics.imageTokens.input - sessionMetrics.imageTokens.inputCached;
  
  // Calculate costs in dollars (pricing is per 1M tokens)
  const textCosts = {
    input: (textInputNonCached / 1000000) * PRICING.text.input,
    inputCached: (sessionMetrics.textTokens.inputCached / 1000000) * PRICING.text.inputCached,
    output: (sessionMetrics.textTokens.output / 1000000) * PRICING.text.output
  };

  const imageCosts = {
    input: (imageInputNonCached / 1000000) * PRICING.image.input,
    inputCached: (sessionMetrics.imageTokens.inputCached / 1000000) * PRICING.image.inputCached
  };

  const totalTextCost = textCosts.input + textCosts.inputCached + textCosts.output;
  const totalImageCost = imageCosts.input + imageCosts.inputCached;
  const totalCost = totalTextCost + totalImageCost;
  const averageCostPerRequest = sessionMetrics.totalRequests > 0 ? totalCost / sessionMetrics.totalRequests : 0;

  // Calculate average response time
  const averageResponseTime = sessionMetrics.responseTimes.length > 0 ? 
    sessionMetrics.totalResponseTime / sessionMetrics.responseTimes.length : 0;

  return {
    textCosts,
    imageCosts,
    totalTextCost,
    totalImageCost,
    totalCost,
    averageCostPerRequest,
    averageResponseTime,
    textInputNonCached,
    imageInputNonCached
  };
}

function displayCostBreakdown() {
  const costs = calculateCosts();
  const costBreakdown = document.querySelector("#costBreakdown");
  const metricsContent = document.querySelector("#metricsContent");

  // Calculate session duration
  const duration = sessionEndTime - sessionStartTime;
  const durationSeconds = Math.floor(duration / 1000);
  const durationMinutes = Math.floor(durationSeconds / 60);
  const remainingSeconds = durationSeconds % 60;
  const durationText = durationMinutes > 0 ? 
    `${durationMinutes}m ${remainingSeconds}s` : 
    `${durationSeconds}s`;

  // Generate individual request details HTML
  let requestDetailsHTML = '';
  sessionMetrics.requestDetails.forEach((request, index) => {
    const timestamp = request.timestamp.toLocaleTimeString();
    const responseTimeText = request.responseTime ? `${request.responseTime}ms` : 'N/A';
    requestDetailsHTML += `
      <div class="request-item">
        <div class="request-header">
          <strong>Request #${request.requestNumber}</strong> 
          <span class="request-time">(${timestamp})</span>
        </div>
        <div class="request-details">
          <div class="request-tokens">
            Text: ${request.tokens.textInputNonCached + request.tokens.textInputCached} input (${request.tokens.textInputCached} cached), ${request.tokens.textOutput} output |
            Images: ${request.tokens.imageInputNonCached + request.tokens.imageInputCached} input (${request.tokens.imageInputCached} cached)
          </div>
          <div class="request-cost">Cost: <strong>${request.totalCost.toFixed(6)}</strong> | Response Time: <strong>${responseTimeText}</strong></div>
        </div>
      </div>
    `;
  });

  // Update metrics display
  metricsContent.innerHTML = `
    <div class="metrics-section">
      <h4>⏱️ Session Duration</h4>
      <div class="stats-item">
        Session Duration: <span class="stats-value highlight-duration">${durationText}</span>
      </div>
      <div class="stats-item">
        Started: <span class="stats-value">${sessionStartTime.toLocaleTimeString()}</span>
      </div>
      <div class="stats-item">
        Ended: <span class="stats-value">${sessionEndTime.toLocaleTimeString()}</span>
      </div>
    </div>

    <div class="metrics-section">
      <h4>📊 Token Usage Summary</h4>
      <div class="token-grid">
        <div class="token-category">
          <h5>Text Tokens</h5>
          <div class="token-item">Input (Non-cached): <span class="token-count">${costs.textInputNonCached.toLocaleString()}</span></div>
          <div class="token-item">Input (Cached): <span class="token-count">${sessionMetrics.textTokens.inputCached.toLocaleString()}</span></div>
          <div class="token-item">Total Input: <span class="token-count">${sessionMetrics.textTokens.input.toLocaleString()}</span></div>
          <div class="token-item">Output: <span class="token-count">${sessionMetrics.textTokens.output.toLocaleString()}</span></div>
        </div>
        <div class="token-category">
          <h5>Image Tokens</h5>
          <div class="token-item">Input (Non-cached): <span class="token-count">${costs.imageInputNonCached.toLocaleString()}</span></div>
          <div class="token-item">Input (Cached): <span class="token-count">${sessionMetrics.imageTokens.inputCached.toLocaleString()}</span></div>
          <div class="token-item">Total Input: <span class="token-count">${sessionMetrics.imageTokens.input.toLocaleString()}</span></div>
        </div>
      </div>
    </div>

    <div class="metrics-section">
      <h4>📋 Individual Request Details</h4>
      <div class="request-list">
        ${requestDetailsHTML}
      </div>
    </div>

    <div class="metrics-section">
      <h4>💰 Cost Breakdown</h4>
      <div class="cost-grid">
        <div class="cost-category">
          <h5>Text Costs</h5>
          <div class="cost-item">Input (Non-cached): <span class="cost-amount">$${costs.textCosts.input.toFixed(6)}</span></div>
          <div class="cost-item">Input (Cached): <span class="cost-amount">$${costs.textCosts.inputCached.toFixed(6)}</span></div>
          <div class="cost-item">Output: <span class="cost-amount">$${costs.textCosts.output.toFixed(6)}</span></div>
          <div class="cost-subtotal">Subtotal: <span class="cost-amount">$${costs.totalTextCost.toFixed(6)}</span></div>
        </div>
        <div class="cost-category">
          <h5>Image Costs</h5>
          <div class="cost-item">Input (Non-cached): <span class="cost-amount">$${costs.imageCosts.input.toFixed(6)}</span></div>
          <div class="cost-item">Input (Cached): <span class="cost-amount">$${costs.imageCosts.inputCached.toFixed(6)}</span></div>
          <div class="cost-subtotal">Subtotal: <span class="cost-amount">$${costs.totalImageCost.toFixed(6)}</span></div>
        </div>
      </div>
      <div class="cost-total">
        <strong>Total Session Cost: $${costs.totalCost.toFixed(6)}</strong>
      </div>
      <div class="cache-info">
        <h6>💡 About Cached Tokens</h6>
        <p>Cached tokens are reused from recent requests and cost 90% less! Higher cache hit rates = lower costs.</p>
        <p><strong>Cache Hit Rate:</strong> 
          Text: ${sessionMetrics.textTokens.input > 0 ? ((sessionMetrics.textTokens.inputCached / sessionMetrics.textTokens.input) * 100).toFixed(1) : 0}% | 
          Images: ${sessionMetrics.imageTokens.input > 0 ? ((sessionMetrics.imageTokens.inputCached / sessionMetrics.imageTokens.input) * 100).toFixed(1) : 0}%
        </p>
      </div>
    </div>

    <div class="metrics-section">
      <h4>📈 Session Stats</h4>
      <div class="stats-item">Total API Responses: <span class="stats-value">${sessionMetrics.totalRequests}</span></div>
      <div class="stats-item">Average Cost per Response: <span class="stats-value">$${costs.averageCostPerRequest.toFixed(6)}</span></div>
      <div class="stats-item">Average Response Time: <span class="stats-value highlight-duration">${costs.averageResponseTime > 0 ? Math.round(costs.averageResponseTime) + 'ms' : 'N/A'}</span></div>
      <div class="stats-item">Total Tokens Used: <span class="stats-value">${(
        sessionMetrics.textTokens.input + 
        sessionMetrics.textTokens.output + 
        sessionMetrics.imageTokens.input
      ).toLocaleString()}</span></div>
    </div>
  `;

  costBreakdown.classList.remove("hidden");
}

function stopSession() {
  // Record session end time
  sessionEndTime = new Date();
  
  // Stop screenshot interval
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = null;
  }

  // Stop screen sharing
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  // Close WebRTC connection
  if (currentPeerConnection) {
    currentPeerConnection.close();
    currentPeerConnection = null;
    currentDataChannel = null;
  }

  // Reset UI
  document.querySelector("#startButton").disabled = false;
  document.querySelector("#startButton").textContent = "Start Screen Sharing Session";
  document.querySelector("#sessionControls").classList.add("hidden");
  
  // Keep content container visible so responses remain shown
  // document.querySelector("#contentContainer").classList.add("hidden"); // Commented out to keep responses visible
  
  // Reset conversation history and request timing
  conversationHistory = [];
  currentRequestStartTime = null;

  // Display cost breakdown
  if (sessionMetrics.totalRequests > 0) {
    // Add a separator message in the response area
    const responseArea = document.querySelector("#response");
    const duration = sessionEndTime - sessionStartTime;
    const durationSeconds = Math.floor(duration / 1000);
    const durationMinutes = Math.floor(durationSeconds / 60);
    const remainingSeconds = durationSeconds % 60;
    const durationText = durationMinutes > 0 ? 
      `${durationMinutes}m ${remainingSeconds}s` : 
      `${durationSeconds}s`;
    
    const avgResponseTime = sessionMetrics.responseTimes.length > 0 ? 
      Math.round(sessionMetrics.totalResponseTime / sessionMetrics.responseTimes.length) : 0;
    
    responseArea.textContent += "\n" + "=".repeat(60) + "\n";
    responseArea.textContent += `🛑 SESSION ENDED (Duration: ${durationText})\n`;
    responseArea.textContent += `📊 ${sessionMetrics.totalRequests} responses received\n`;
    responseArea.textContent += `⏱️ Average response time: ${avgResponseTime}ms\n`;
    responseArea.textContent += "📈 Complete cost breakdown displayed below\n";
    responseArea.textContent += "=".repeat(60) + "\n";
    responseArea.scrollTop = responseArea.scrollHeight;
    
    displayCostBreakdown();
  }
}
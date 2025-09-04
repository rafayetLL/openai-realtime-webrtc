let currentPeerConnection = null;
let currentDataChannel = null;
let conversationHistory = [];
let screenStream = null;
let screenshotInterval = null;

async function startSession() {
  const button = document.querySelector("#startButton");
  const sessionControls = document.querySelector("#sessionControls");
  const contentContainer = document.querySelector("#contentContainer");

  button.disabled = true;
  button.textContent = "Starting...";

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

        if (msg.type === "error") {
          console.error("Realtime API error:", msg.error);
          document.querySelector("#response").textContent += `\nError: ${msg.error.message}\n\n`;
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
    contentContainer.classList.remove("hidden");
    
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
            detail: "high"
          }
        ]
      }
    };

    currentDataChannel.send(JSON.stringify(imageMessage));

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

function stopSession() {
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
  document.querySelector("#contentContainer").classList.add("hidden");
  
  // Clear response area
  document.querySelector("#response").textContent = "";
  
  // Reset conversation history
  conversationHistory = [];
}
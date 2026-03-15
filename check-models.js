import dotenv from 'dotenv';
dotenv.config();

const fetchModels = async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return console.log("❌ Алдаа: .env файл дотор GEMINI_API_KEY олдсонгүй!");
  }

  console.log("Google-ийн сервер рүү холбогдож байна...");
  
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();
    
    if (data.error) {
       console.log("❌ API Алдаа:", data.error.message);
       return;
    }

    if (data.models) {
      console.log("\n✅ Таны API key-ээр ашиглаж болох Text Generate загварууд:");
      data.models.forEach(m => {
        // Only show models that support text generation
        if (m.supportedGenerationMethods.includes("generateContent")) {
           // We remove the "models/" prefix because the SDK adds it automatically
           console.log(`👉 ${m.name.replace('models/', '')}`);
        }
      });
      console.log("\nДээрх нэрнүүдээс аль нэгийг нь хуулж аваад server.js доторх загварын нэрээр солино уу.");
    }
  } catch (error) {
    console.error("Сүлжээний алдаа:", error);
  }
};

fetchModels();
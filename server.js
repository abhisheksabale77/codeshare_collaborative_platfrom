// server.js

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const passport = require("passport");
const LocalStrategy = require("passport-local").Strategy;
const session = require("express-session");
const { default: axios } = require("axios");
const { HfInference } = require("@huggingface/inference");
const ACTIONS = require("./src/Actions");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.json());
app.use(cors());

// -------------------- MongoDB --------------------
mongoose
  .connect(process.env.MONGO_URL)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB Error:", err));

// -------------------- Models --------------------
const UserSchema = new mongoose.Schema({
  username: String,
  email: String,
  password: String,
});
const User = mongoose.model("User", UserSchema);

const ChatMessage = mongoose.model("ChatMessage", {
  username: String,
  message: String,
});

// -------------------- Passport --------------------
passport.use(
  new LocalStrategy(async (username, password, done) => {
    try {
      const user = await User.findOne({ username: username.toUpperCase() });
      if (!user) return done(null, false, { message: "Invalid username" });

      const validPass = await bcrypt.compare(password, user.password);
      if (!validPass) return done(null, false, { message: "Invalid password" });

      return done(null, user);
    } catch (error) {
      return done(error);
    }
  })
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) =>
  User.findById(id, (err, user) => done(err, user))
);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret-key",
    resave: true,
    saveUninitialized: true,
  })
);
app.use(passport.initialize());
app.use(passport.session());

// -------------------- Auth Controllers --------------------
const createUser = async (req, res) => {
  try {
    console.log("Signup body:", req.body);

    const emailExists = await User.findOne({ email: req.body.email });
    if (emailExists) return res.status(400).send("Email already exists");

    const usernameExists = await User.findOne({
      username: req.body.username.toUpperCase(),
    });
    if (usernameExists) return res.status(400).send("Username already exists");

    const salt = await bcrypt.genSalt(10);
    const hashPassword = await bcrypt.hash(req.body.password, salt);

    const newUser = new User({
      username: req.body.username.toUpperCase(),
      email: req.body.email,
      password: hashPassword,
    });

    const savedUser = await newUser.save();
    res.status(201).json(savedUser);
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ msg: error.message });
  }
};

const loginUser = async (req, res) => {
  try {
    console.log("Login body:", req.body);

    const user = await User.findOne({
      username: req.body.username.toUpperCase(),
    });
    if (!user) return res.status(400).send("Invalid username");

    const validPass = await bcrypt.compare(req.body.password, user.password);
    if (!validPass) return res.status(400).send("Invalid password");

    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET || "jwt-secret",
      { expiresIn: "1h" }
    );

    res.json({ token });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).send("Login failed");
  }
};

// -------------------- Routes --------------------
const router = express.Router();
router.post("/signup", createUser);
router.post("/login", loginUser);
app.use("/api", router);

// -------------------- Hugging Face --------------------
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);

app.post("/api/suggest-code", async (req, res) => {
  const { codeSnippet, language } = req.body;
  if (!codeSnippet || !language)
    return res
      .status(400)
      .json({ error: "Code snippet and language are required." });

  try {
    const response = await hf.textGeneration({
      model: "bigcode/starcoder",
      inputs: codeSnippet,
      parameters: { max_new_tokens: 100, temperature: 0.7, top_p: 0.9 },
    });

    const suggestion = response.generated_text
      .replace(codeSnippet, "")
      .trim();

    res.status(200).json({ suggestion });
  } catch (error) {
    console.error("Hugging Face error:", error);
    res.status(500).json({ error: "Failed to generate suggestion" });
  }
});

// -------------------- JDoodle --------------------
// app.post("/execute", async (req, res) => {
//   try {
//     const { script, language, stdin } = req.body;

//     const payload = {
//       clientId: process.env.JDOODLE_CLIENT_ID,
//       clientSecret: process.env.JDOODLE_CLIENT_SECRET,
//       script,
//       language,
//     };

//     if (stdin) payload.stdin = stdin;

//     // ✅ FIX: Only add versionIndex for supported languages, skip JavaScript
//     if (language.toLowerCase() === "python3") {
//       payload.versionIndex = "3";
//     } else if (["c", "cpp"].includes(language.toLowerCase())) {
//       payload.versionIndex = "0";
//     }
//     // For "javascript", no versionIndex added

//     const response = await axios.post(
//       "https://api.jdoodle.com/v1/execute",
//       payload
//     );

//     res.json(response.data);
//   } catch (error) {
//     console.error("JDoodle error:", error.response?.data || error.message);
//     res
//       .status(error.response?.status || 500)
//       .json(error.response?.data || { error: "Execution failed" });
//   }
// });

app.post("/execute", async (req, res) => {
  try {
    let { script, language, stdin } = req.body;

    // Map language to JDoodle-compatible names
    if (language.toLowerCase() === "javascript") language = "nodejs";
    if (language.toLowerCase() === "cpp") language = "cpp17"; // optional if needed

    const payload = {
      clientId: process.env.JDOODLE_CLIENT_ID,
      clientSecret: process.env.JDOODLE_CLIENT_SECRET,
      script,
      language,
    };

    if (stdin) payload.stdin = stdin;

    // Only add versionIndex for languages that support it
    const languagesWithVersion = ["python3", "c", "cpp"];
    if (languagesWithVersion.includes(language.toLowerCase())) {
      payload.versionIndex = "0"; // default version
    }

    const response = await axios.post(
      "https://api.jdoodle.com/v1/execute",
      payload
    );

    res.json(response.data);
  } catch (error) {
    console.error("JDoodle error:", error.response?.data || error.message);
    res
      .status(error.response?.status || 500)
      .json(error.response?.data || { error: "Execution failed" });
  }
});

// -------------------- Socket.io --------------------
const userSocketMap = {};
let userChanges = {};

function getAllConnectedClients(roomId) {
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    (socketId) => {
      return { socketId, username: userSocketMap[socketId] };
    }
  );
}

io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);
  userChanges = {};

  socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    socket.join(roomId);
    const clients = getAllConnectedClients(roomId);
    clients.forEach(({ socketId }) => {
      io.to(socketId).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
      });
    });
  });

  socket.on(ACTIONS.SEND_MESSAGE, ({ roomId, message }) => {
    const senderUsername = userSocketMap[socket.id];
    const chatMessage = new ChatMessage({
      username: senderUsername,
      message,
    });
    chatMessage.save();
    io.in(roomId).emit(ACTIONS.RECEIVE_MESSAGE, {
      username: senderUsername,
      message,
    });
  });

  socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
    socket.in(roomId).emit(ACTIONS.CODE_CHANGE, { code });
  });

  socket.on(ACTIONS.SYNC_CODE, ({ socketId, code }) => {
    io.to(socketId).emit(ACTIONS.CODE_CHANGE, { code });
  });

  socket.on(ACTIONS.TOGGLE_EDITOR_LOCK, ({ roomId, editorLocked }) => {
    socket.to(roomId).emit(ACTIONS.TOGGLE_EDITOR_LOCK, { editorLocked });
  });

  socket.on("UPLOAD_FILE", ({ roomId, fileContent }) => {
    io.to(roomId).emit("SYNC_CODE", { code: fileContent });
  });

  socket.on("disconnecting", () => {
    const rooms = [...socket.rooms];
    rooms.forEach((roomId) => {
      socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username: userSocketMap[socket.id],
      });
    });
    delete userSocketMap[socket.id];
  });
});

// -------------------- Server --------------------
const PORT = process.env.PORT || 5050;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

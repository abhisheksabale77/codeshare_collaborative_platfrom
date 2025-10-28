// socket.js
import { io } from "socket.io-client";

const backendURL = process.env.REACT_APP_BACKEND_URL || "http://localhost:5050";

export const initSocket = () => {
  const options = {
    transports: ["websocket", "polling"],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  };

  const socket = io(backendURL, options);
  return socket;
};

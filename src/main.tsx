import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./styles/global.css";
import "./styles/layout.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("找不到 #root 元素");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

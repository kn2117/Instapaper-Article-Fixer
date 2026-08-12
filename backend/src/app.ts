import express from "express";

const app = express();
const PORT = 3000;

app.use(express.json());

app.get("/api/hello", (_req, res) => {
  res.json({ message: "Hello from Express" });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
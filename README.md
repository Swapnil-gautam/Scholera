# Scholera AI 

An AI-native backend that ingests course materials (PDF/PPTX) and powers a **RAG Tutor** grounded in those lectures.

## Demo

<video src="Demo_video.mp4" controls muted playsinline style="max-width: 100%;"></video>

- [Download demo video (`Demo_video.mp4`)](Demo_video.mp4)

## Installation

### 1) Install dependencies

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2) Configure environment

```bash
cp .env.example .env
```

Set `SCHOLERA_GEMINI_API_KEY` in `.env`.

### 3) Run

```bash
python -m scholera.cli serve
```

Open `http://localhost:8000/`.

## Quick start (CLI)

```bash
python -m scholera.cli create-course --title "3D Computer Vision"
python -m scholera.cli ingest --course-id <ID> --file lecture01.pdf --lecture-number 1 --lecture-title "Intro"
python -m scholera.cli ask --course-id <ID> "Explain the pinhole camera model."
```

## What’s included

- **Tutor**: grounded answers with citations like `[Lecture X, Slide Y]`
- **Ingestion**: PDF/PPTX → per-slide/page chunks (with optional vision descriptions)
- **Retrieval**: hybrid search (BM25 + vectors)
- **Extras**: quizzes, study guides, audio overview

## Notes

- `pdf2image` may require **Poppler** installed on your system.
- The web UI renders LaTeX using **KaTeX**.

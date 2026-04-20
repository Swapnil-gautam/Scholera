# Scholera AI Backend

An AI-native backend for a Learning Management System that ingests academic course materials (PDFs, PowerPoints) and powers intelligent features for students and professors — starting with an **AI Tutor** that can answer questions grounded in the full course corpus.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How It Works](#how-it-works)
  - [Ingestion Pipeline](#ingestion-pipeline)
  - [Retrieval Layer](#retrieval-layer)
  - [AI Tutor (Feature A)](#ai-tutor-feature-a)
- [Quiz Generator (Feature B — Design Document)](#quiz-generator-feature-b--design-document)
- [Handling Visual & Mathematical Content](#handling-visual--mathematical-content)
- [Key Design Decisions](#key-design-decisions)
- [Limitations & Honest Trade-offs](#limitations--honest-trade-offs)
- [Setup & Usage](#setup--usage)
- [Evaluation](#evaluation)
- [What Would Break First at Scale](#what-would-break-first-at-scale)

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────────┐
                        │              Scholera AI Backend            │
                        └─────────────────────────────────────────────┘

    ┌──────────────┐     ┌──────────────────────────────────────────┐
    │  PDF / PPTX  │────▸│           INGESTION PIPELINE             │
    │   Upload     │     │                                          │
    └──────────────┘     │  1. Structural Extraction (Marker/pptx)  │
                         │  2. Page Image Rendering (pdf2image)     │
                         │  3. Vision Pass (Gemini) for visual      │
                         │     content: diagrams, equations, charts │
                         │  4. Semantic Chunking (slide-level)      │
                         │  5. Hierarchical Summarization           │
                         │     - Lecture summaries                  │
                         │     - Cross-lecture topic summaries      │
                         │  6. Embedding + Indexing                 │
                         └──────────┬───────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
             ┌──────────┐   ┌──────────┐   ┌──────────────┐
             │ ChromaDB │   │  BM25    │   │   SQLite     │
             │ (vectors)│   │  Index   │   │  (metadata)  │
             └──────────┘   └──────────┘   └──────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
                         ┌────────────────────┐
    ┌──────────┐         │  RETRIEVAL LAYER   │
    │ Student  │────────▸│                    │
    │ Question │         │  Hybrid Search     │
    └──────────┘         │  (BM25 + Vector)   │
                         │  RRF Fusion        │
                         │  Cross-Encoder     │
                         │  Reranking         │
                         └────────┬───────────┘
                                  ▼
                         ┌────────────────────┐
                         │  GENERATION LAYER  │
                         │                    │
                         │  Gemini Flash      │
                         │  + Grounded Prompt │
                         │  + Source Citations │
                         └────────┬───────────┘
                                  ▼
                         ┌────────────────────┐
                         │  Answer + Sources  │
                         └────────────────────┘
```

---

## How It Works

### Ingestion Pipeline

When a professor uploads a lecture file, the system processes it through six stages:

**1. Structural Extraction**
- **PDFs** are processed with [Marker](https://github.com/VikParuchuri/marker), which produces clean Markdown with LaTeX equations preserved, table structures maintained, and image locations marked.
- **PowerPoint files** are processed with `python-pptx`, extracting text from all shapes, tables, and embedded images.

**2. Page Image Rendering**
Every page/slide is rendered to a PNG image using `pdf2image` (backed by Poppler). These images serve as input for the visual understanding pass.

**3. Visual Understanding Pass (Gemini Vision)**
This is the most important step for handling non-textual content. For each page, we compute a text density score (character count). Pages with low text density — common in engineering/math courses where slides contain only diagrams or equations — are sent to **Gemini 2.0 Flash's vision capability** with this prompt:

> "You are an expert teaching assistant. Describe the academic content of this lecture slide in detail. Include any text visible, descriptions of diagrams, charts, figures, and their meaning. Any mathematical equations or formulas, written in LaTeX notation. What a student should understand from this slide."

Pages with high text density also get a vision pass if they contain detected images. The result is a rich textual description that captures the *meaning* of visual content — turning a diagram of a rotation matrix into a searchable, retrievable paragraph about 3D transformations.

**4. Semantic Chunking**
The primary chunk unit is **one slide/page** — the natural unit of meaning in lecture materials. Each chunk carries metadata:
- `course_id`, `lecture_number`, `lecture_title`, `page_number`
- `has_equations`, `has_images`
- `chunk_type`: "slide", "lecture_summary", or "topic_summary"

The chunk's `combined_text` merges extracted text with the vision description. Pages exceeding 1000 tokens are split into overlapping sub-chunks.

**5. Hierarchical Summarization**
After chunking, the system generates summaries at two levels:
- **Lecture-level summaries**: All slide chunks from one lecture are sent to Gemini to produce a 400-600 word summary covering main topics, key formulas, and how concepts build on each other.
- **Cross-lecture topic summaries**: After any new lecture is ingested, all lecture summaries are analyzed together to produce a synthesis of how topics connect across the entire course.

These summaries are embedded and stored as retrievable chunks, enabling the system to answer cross-lecture questions without needing to retrieve dozens of individual slides.

**6. Embedding & Indexing**
All chunks (slides + summaries) are:
- Embedded with `all-MiniLM-L6-v2` (384-dimensional, runs locally) and stored in ChromaDB
- Indexed with BM25 (tokenized text) for keyword matching

When a professor uploads their 8th PDF, only that document is processed through stages 1-4. The system then incrementally updates the lecture summary for that lecture and regenerates topic summaries across all lectures. Existing chunks from earlier uploads are untouched.

---

### Retrieval Layer

When a question comes in, the retrieval pipeline runs:

1. **Query Analysis**: Parse the query for metadata hints (e.g., "Week 3" → filter to `lecture_number=3`)
2. **BM25 Search**: Keyword-based search over all chunk texts → top 20 candidates. Catches exact term matches critical for technical vocabulary (e.g., "epipolar geometry", "backpropagation").
3. **Vector Search**: Semantic similarity search in ChromaDB → top 20 candidates. Catches meaning-based matches where the student uses different words than the slides.
4. **Reciprocal Rank Fusion (RRF)**: Merges the two ranked lists into a single ranking. RRF is simple, parameter-light, and empirically strong — it works by `score(d) = Σ 1/(k + rank(d))` across both lists.
5. **Cross-Lecture Injection**: If the query contains indicators like "relate", "compare", "across lectures", "everything" — the system injects lecture summaries and topic summaries into the candidate pool.
6. **Cross-Encoder Reranking**: The top 20 fused candidates are re-scored by a cross-encoder (`ms-marco-MiniLM-L-6-v2`) which reads each (query, chunk) pair jointly for more accurate relevance judgment. The top 8 are passed to the generation layer.

---

### AI Tutor (Feature A)

The tutor receives the reranked chunks and constructs a grounded prompt:

```
System: You are an AI tutor for the course "{course_title}".
- Answer ONLY using the provided lecture materials.
- If the answer spans multiple lectures, explicitly reference which lectures.
- Cite your sources as [Lecture X, Slide Y].
- If unsure, say so honestly. Do NOT make up information.

=== COURSE MATERIALS ===
[Source 1: Lecture 3, Slide 14 — rotation_matrices.pdf]
Content of the chunk...

[Source 2: Lecture 7, Slide 8 — camera_models.pdf]
Content of the chunk...
=== END MATERIALS ===

Student Question: How do rotation matrices relate to camera calibration?
```

The response includes:
- The answer text with inline source citations
- A structured `sources` list: `[{lecture_number, page_number, source_file}]`
- The number of chunks retrieved

**Cross-lecture questions** work because: (a) the hierarchical summaries provide high-level connections, (b) the retrieval layer injects these summaries when it detects cross-lecture intent, and (c) the prompt explicitly instructs the model to reference multiple lectures.

---

## Quiz Generator (Feature B — Design Document)

The Quiz Generator shares the **exact same ingestion pipeline and retrieval layer** as the AI Tutor. The only difference is in how retrieval is triggered and how the LLM prompt is structured.

### Input

```json
{
    "num_questions": 10,
    "difficulty": "medium",
    "lectures_to_cover": [3, 5, 7],
    "topics": ["camera calibration", "epipolar geometry"],
    "question_types": ["mcq", "short_answer"]
}
```

If `lectures_to_cover` is empty, the system covers all lectures proportionally.

### How It Uses the Same Foundation

**Retrieval**: Instead of a student's free-form question, the system constructs programmatic queries:
- `"Key concepts and important definitions from Lecture 3 about camera calibration"`
- `"Main formulas and theorems from Lecture 5 about epipolar geometry"`

For each lecture/topic combination, 8-10 chunks are retrieved. For "cover everything" mode, the system retrieves lecture-level summaries for all lectures and samples proportionally.

**Difficulty Control via Bloom's Taxonomy**:
- **Easy**: "Remember" level — definitions, recall of facts. Prompt: *"Generate a question that tests whether the student can recall a key definition or fact."*
- **Medium**: "Understand/Apply" level — explaining concepts, applying formulas. Prompt: *"Generate a question that tests whether the student can explain a concept or apply a formula to a new scenario."*
- **Hard**: "Analyze/Evaluate" level — comparing concepts, connecting ideas across lectures. Prompt: *"Generate a question that requires the student to analyze relationships between concepts or evaluate different approaches."*

**Generation Prompt (for MCQ)**:

```
You are a professor creating a quiz for the course "{course_title}".

Generate {n} multiple-choice questions based ONLY on the provided materials.

For each question:
1. Write a clear question stem
2. Provide 4 options (A-D) with exactly one correct answer
3. The correct answer must be directly supported by the materials
4. Distractors should be plausible but clearly wrong based on the material
5. Include a brief explanation referencing the source [Lecture X, Slide Y]

Difficulty level: {difficulty}
{difficulty_instruction}

Materials:
{retrieved_chunks}
```

**Validation**: After generation, each question is checked:
- Does the correct answer appear in or follow from the retrieved source chunks?
- Are the distractors plausible (not absurd)?
- Questions that fail validation are regenerated or discarded.

**Coverage Guarantee**: For "cover everything" mode, the system ensures at least one question per lecture by cycling through lecture summaries. This prevents the quiz from clustering on one topic.

### Why This Works from the Same Foundation

Both features are just different "views" into the same knowledge base:
- The **AI Tutor** takes a student question → retrieves relevant chunks → generates an answer
- The **Quiz Generator** takes a professor's spec → retrieves relevant chunks → generates questions

The ingestion pipeline, chunk storage, embedding, BM25 index, hierarchical summaries, and hybrid retrieval are identical. Only the final prompt to the LLM changes. A developer could implement Feature B by:
1. Adding a `scholera/generation/quiz.py` with the quiz prompt templates
2. Adding a `POST /courses/{id}/quiz/generate` endpoint
3. Writing a retrieval wrapper that constructs queries from quiz parameters

No changes to ingestion, storage, or retrieval would be needed.

---

## Handling Visual & Mathematical Content

### The Challenge

Academic slides — especially in STEM courses — are not just text. A 3D Computer Vision lecture might have slides that contain:
- A diagram of epipolar geometry with no text explanation
- A slide with only a 4x4 transformation matrix
- A chart comparing different feature detectors
- Code output screenshots

Traditional text-only RAG systems lose 30-50% of the information on these slides.

### Our Approach

**Dual extraction**: Every page gets both text extraction (Marker) and image rendering (pdf2image). Marker handles LaTeX equations well, converting them to `$...$` notation. But it cannot interpret diagrams.

**Vision-based understanding**: Pages with low text density OR detected images get sent to Gemini Vision. This turns a diagram of a pinhole camera model into a paragraph like:

> "This slide shows a pinhole camera model diagram. A 3D point P in world coordinates is projected through the camera center (optical center) onto the image plane, creating a 2D point p. The relationship is governed by the projection equation p = K[R|t]P, where K is the intrinsic matrix, R is the rotation matrix, and t is the translation vector..."

This description is merged with any extracted text to form the chunk's `combined_text`, which is then embedded and indexed. Now when a student asks "How does the pinhole camera model work?", the system can retrieve this chunk even though the original slide had no searchable text.

### Equations

Marker preserves LaTeX notation from PDFs. For slides where equations are rendered as images (common in PowerPoint), Gemini Vision transcribes them to LaTeX. The system stores equations in LaTeX form, which:
- Is searchable (BM25 can match `\nabla`, `\frac{d}{dx}`)
- Embeds meaningfully (the embedding model has seen LaTeX in training data)
- Renders correctly in the tutor's response

### Known Limitations

- **Handwritten content**: If slides contain handwritten annotations, Gemini Vision may misread them.
- **Complex multi-part diagrams**: Very busy diagrams with many labeled parts may get partially described.
- **Animated slides**: PowerPoint animations are captured as a single state; multi-step visual explanations are collapsed.
- **Slides with no text AND no visual meaning** (e.g., a title-only slide, or a "Questions?" slide): These produce near-empty chunks and are effectively filtered out.

---

## Key Design Decisions

### Why Hierarchical Summaries?

Cross-lecture questions are the hardest case for RAG. A student asking "How does Week 3 relate to Week 9?" cannot be answered by retrieving 8 individual slides — the system needs to understand the *arc* of the course. Lecture summaries capture each lecture's key ideas in ~500 words, and topic summaries synthesize connections across lectures. These are embedded and retrievable just like slide chunks, so the system can pull the right level of abstraction for each query.

### Why Gemini Vision for Ingestion?

Text-only extraction from academic slides is lossy. The assignment explicitly calls out this concern: "What happens to a formula-heavy page?" Our answer: we send it to a vision model and get a description that captures the educational meaning, not just the pixels. This is the single highest-impact design choice for handling STEM courses.

### Why Hybrid Search (BM25 + Vector)?

BM25 and vector search have complementary strengths:
- BM25 excels at exact term matching: searching for "Jacobian matrix" should return slides that literally mention "Jacobian matrix"
- Vector search excels at semantic matching: searching for "how derivatives work in neural networks" should return slides about backpropagation even if they never use the word "derivative"

RRF fusion combines both without needing to tune weights.

### Why Slide-Level Chunking?

In lecture slides, each slide is a deliberate unit of information — the professor designed it to convey one idea. Chunking at the slide level preserves this pedagogical structure. It also provides natural metadata boundaries (slide number) for source citation.

### Why ChromaDB?

Simplicity. ChromaDB is file-based (no server to run), supports cosine similarity, handles metadata filtering, and is sufficient for the scale of a single course (~1000-2000 chunks). For a production system handling hundreds of courses, I would migrate to Qdrant or Weaviate.

---

## Limitations & Honest Trade-offs

1. **Verbally-explained slides**: When a professor's slide contains only an equation or image and they explained it verbally in class, the vision pass can infer *some* meaning from the visual content, but cannot recover the professor's spoken explanation. If lecture recordings/transcripts were available, they could fill this gap.

2. **Ingestion latency**: Processing a 100-page PDF takes 2-5 minutes due to the vision pass (one Gemini API call per low-text-density page). This is acceptable for batch uploads but not for real-time "upload and immediately query."

3. **Topic summary quality**: Cross-lecture topic summaries are generated from lecture summaries, which means they are two levels of abstraction from the source material. Very specific cross-lecture questions may still need direct slide retrieval.

4. **Evaluation is partially manual**: While retrieval recall can be automated, judging answer *correctness* and *faithfulness* ultimately requires human review or an LLM-as-judge approach (which has its own biases).

5. **Single-course scope**: The current architecture treats each course independently. A multi-course system (e.g., "How does what I learned in Linear Algebra apply to Computer Vision?") would need a cross-course retrieval layer.

---

## Setup & Usage

### Prerequisites

- Python 3.11+
- [Poppler](https://poppler.freedesktop.org/) (for `pdf2image` — install via `conda install poppler` or system package manager)
- A [Google Gemini API key](https://aistudio.google.com/apikey) (free tier is sufficient)

### Installation

```bash
git clone https://github.com/your-username/scholera-ai.git
cd scholera-ai
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Configuration

```bash
cp .env.example .env
# Edit .env and add your Gemini API key:
# SCHOLERA_GEMINI_API_KEY=your-key-here
```

### Quick Start (CLI)

```bash
# Create a course
python -m scholera.cli create-course --title "3D Computer Vision"

# Note the course ID from the output, then ingest lecture files
python -m scholera.cli ingest --course-id <ID> --file lecture01.pdf --lecture-number 1 --lecture-title "Introduction to 3D Vision"
python -m scholera.cli ingest --course-id <ID> --file lecture02.pdf --lecture-number 2 --lecture-title "Camera Models"

# Ask a question
python -m scholera.cli ask --course-id <ID> "How does the pinhole camera model work?"

# Run evaluation
python -m scholera.cli evaluate --course-id <ID> --test-set scholera/evaluation/test_sets/example_test_set.json --output eval_report.json
```

### Quick Start (API)

```bash
# Start the server
python -m scholera.cli serve

# Create a course
curl -X POST http://localhost:8000/courses/ \
  -H "Content-Type: application/json" \
  -d '{"title": "3D Computer Vision"}'

# Upload a lecture
curl -X POST http://localhost:8000/courses/<ID>/materials/ \
  -F "file=@lecture01.pdf" \
  -F "lecture_number=1" \
  -F "lecture_title=Introduction"

# Check ingestion status
curl http://localhost:8000/courses/<ID>/materials/<MAT_ID>/status

# Ask the AI tutor
curl -X POST http://localhost:8000/courses/<ID>/tutor/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is the vanishing gradient problem?"}'
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/courses/` | Create a new course |
| `GET` | `/courses/` | List all courses |
| `GET` | `/courses/{id}` | Get course details |
| `GET` | `/courses/{id}/stats` | Course statistics |
| `POST` | `/courses/{id}/materials/` | Upload a file (triggers ingestion) |
| `GET` | `/courses/{id}/materials/` | List materials |
| `GET` | `/courses/{id}/materials/{id}/status` | Ingestion status |
| `POST` | `/courses/{id}/tutor/ask` | Ask the AI tutor |

---

## Evaluation

### Approach

The evaluation harness (`scholera/evaluation/eval_runner.py`) runs a test set of questions against the system and measures:

- **Retrieval Recall@8**: Does the correct source lecture appear in the top 8 retrieved chunks?
- **Answer Latency**: Time from question to answer
- **Breakdown by difficulty**: Easy / medium / hard questions
- **Breakdown by type**: Factual / conceptual / cross-lecture questions

### Test Set Format

```json
[
    {
        "question": "What is the epipolar constraint?",
        "expected_answer": "The epipolar constraint states that...",
        "source_lecture": 5,
        "difficulty": "medium",
        "topics": ["epipolar geometry"],
        "type": "factual"
    }
]
```

### Running Evaluation

```bash
python -m scholera.cli evaluate \
  --course-id <ID> \
  --test-set path/to/test_set.json \
  --output eval_report.json
```

The output report contains per-question results (actual answer, sources, latency) and aggregate metrics.

### Ablation Studies

To understand what each component contributes, run these comparisons:
1. **With vs. without vision pass**: Quantifies how much visual understanding adds
2. **With vs. without hierarchical summaries**: Measures cross-lecture question improvement
3. **BM25 only vs. vector only vs. hybrid**: Shows the value of hybrid search
4. **With vs. without reranker**: Measures precision improvement from cross-encoder

---

## What Would Break First at Scale

If the system needed to handle 10x the current load (100+ courses, 1000+ documents):

1. **Gemini API rate limits**: The free tier's 1500 req/day would be hit quickly during batch ingestion. Solution: paid tier or batch API.
2. **ChromaDB**: File-based storage starts to slow at ~100k chunks. Solution: migrate to Qdrant or Weaviate with a proper server deployment.
3. **Ingestion latency**: Linear with page count. Solution: parallelize the vision pass across pages, use async batch processing.
4. **BM25 index**: Currently rebuilt from SQLite on every query. Solution: persist the BM25 index or switch to Elasticsearch/OpenSearch.
5. **Embedding model**: Loading `all-MiniLM-L6-v2` on every worker is memory-wasteful. Solution: serve embeddings via a dedicated model server (Triton, TEI).

The architecture itself scales well — the three-layer design (ingest, retrieve, generate) means each layer can be independently optimized or replaced without affecting the others.

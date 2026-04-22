
I used Cursor with Opus 4.6 mainly.

I had a fair idea of what I wanted to do and how, since I have worked with RAG-based projects before. For testing, I collected data from my previous semester courses and firstly started with creating only the AI tutor part, tested it, did some debugging, and then added RAG and no-RAG mode for my understanding of how the results are different. I added the vision understanding part where pages where text density is low will be sent to the Gemma4 model, and a caption for the image will be received.

There were some issues with the math characters, so I fixed them by using the KaTeX JS library.

To visualize the database content, I also made a tool so that I can visualize the content in the DB.

Then I had this idea that reading text is still a little boring, and what if we create an audio tutor, maybe like a podcast kind of thing like how NotebookLM explains things. Also, similar to NotebookLM, we can later add video generation as well. So I added that functionality, found that the same Gemini API can work for this, did some debugging, and the model output was not exactly an audio file—it needed to be converted into an audio file.

Later, I thought to make it two different modes: student mode and professor mode, and added a quiz generator in the professor mode. The working of the quiz generator was pretty similar to the AI tutor.

I honestly enjoyed a lot while building this proejct. cheers!!


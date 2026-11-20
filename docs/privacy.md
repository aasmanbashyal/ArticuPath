# Rehearsal privacy

Rehearsal records the microphone, camera, or screen you choose for a take. Recordings, transcripts, cue cards, scripts, and saved feedback stay on your computer during local practice. You can review and delete takes in **Sessions** or choose a recording folder and retention limit in **Settings → Storage**. Exported recordings and backups stay wherever you save them.

Transcription runs on your computer. Installing a model downloads files from Hugging Face and the transcription runtime from GitHub. Refreshing the model catalog can also contact GitHub. Those services receive ordinary download requests.

Speaking feedback is optional. If you choose OpenAI and request feedback, Rehearsal sends your coaching prompt, including the transcript and practice details it contains, to the OpenAI API. Your API key authenticates the request. Rehearsal stores a key you save in Windows Credential Manager. You can remove it in **Settings → Feedback**. If you choose Ollama, Rehearsal sends the prompt to the Ollama service on your own computer. You can also review a recording and its transcript without either provider.

For questions about Rehearsal's handling of data, use the [project's support page](https://github.com/aasmanbashyal/rehearsal/issues). Issues are public. Keep recordings, transcripts, and account credentials private.

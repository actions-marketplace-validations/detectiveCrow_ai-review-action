const { context } = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { Configuration, OpenAIApi } = require("openai");

const MAX_PATCH_COUNT = 4000;
const MAX_TOKENS = 3000;

async function initOpenAI(key) {
  // https://platform.openai.com/docs/api-reference/completions/create
  const configuration = new Configuration({
    apiKey: key,
  });
  return new OpenAIApi(configuration);
}

// about model : https://platform.openai.com/docs/models/overview
async function codeReview(openAI, code, model = 'gpt-3.5-turbo') {
  if (!code) {
    return '';
  }

  const language = process.env.LANGUAGE ?  `Answer me in ${process.env.LANGUAGE}` : '';
  const message = `Below is the code patch, please do a brief code review, and ${language}. if any bug, risk, improvement suggestion please let me know
  ${code}
  `;

  console.log(`start chat, message is "${message}"`);

  try {
    const response = await openAI.createChatCompletion({
      model: model,
      messages: [{ role: 'user', content: String(message) }],
      max_tokens: MAX_TOKENS,
      temperature: 1,
    });

    console.log(`response received! response is "${response.data.choices[0].message.content}"`);

    return response.data.choices[0].message.content;
  } catch (error) {
    console.error(error)

    return error;
  }
}

async function run() {
  // Create octokit instance (bring context from github token)
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });

  const { owner, repo } = context.repo;

  // Create new chat instance
  const openAI = await initOpenAI(process.env.OPENAI_API_KEY);

  // Get changed files
  const { data: compareCommits } = await octokit.repos.compareCommits({
    owner: owner,
    repo: repo,
    base: context.payload.pull_request.base.sha,
    head: context.payload.pull_request.head.sha,
  });

  let { files: changedFiles, commits } = compareCommits

  if (context.payload.action === 'synchronize' && commits.length >= 2) {
    const {
      data: { files },
    } = await octokit.repos.compareCommits({
      owner: owner,
      repo: repo,
      base: commits[commits.length - 2].sha,
      head: commits[commits.length - 1].sha,
    });

    const filesNames = files?.map((file) => file.filename) || [];
    changedFiles = changedFiles?.filter((file) =>
      filesNames.includes(file.filename)
    );
  }

  console.log("changed file length is " + changedFiles?.length);

  if (!changedFiles?.length) {
    return 'there is no change';
  }

  console.time('gpt cost');

  // Review code
  for (let i = 0; i < changedFiles.length; i++) {
    console.log(`review (${i + 1}/${changedFiles.length}) start`);
    const file = changedFiles[i];
    const patch = file.patch || '';

    if(file.status !== 'modified' && file.status !== 'added') {
      continue;
    }

    if (!patch || patch.length > MAX_PATCH_COUNT) {
      continue;
    }

    // Get response from chat instance
    const response = await codeReview(openAI, String(patch))
    console.log(`create review comment now...`);
    await octokit.pulls.createReviewComment({
      repo: repo,
      owner: owner,
      pull_number: context.payload.pull_request.number,
      commit_id: commits[commits.length - 1].sha,
      path: file.filename,
      body: response,
      position: patch.split('\n').length - 1,
    });
  }

  console.timeEnd('gpt cost');

  console.info('suceess reviewed', context.payload.pull_request.html_url);

  return 'complete';
}

run();

/* Load environment variables from .env file
import * as dotenv from 'dotenv'
dotenv.config()
*/
import inquirer from 'inquirer'
import express from 'express'
import http from 'http'
import https from 'https'
import axios from 'axios'
import { convert } from 'html-to-text'
import FormData from 'form-data'
import fs from 'fs'
import async from 'async'
import SitemapXMLParser from 'sitemap-xml-parser'
import ora from 'ora'
import cron from 'node-cron'
import exp from 'constants'

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

axios.defaults.httpAgent = httpAgent
axios.defaults.httpsAgent = httpsAgent

const spinner = ora().start()
let failureCount = 0
let shouldContinue = true

/* Set default dir for docs */
const docDir =
  process.cwd() + '/' + (process.env.DOCS_DIRECTORY || 'docs') + '/'

/* Set up Express app */
const app = express()
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// Retrieve the PORT environment variable
const port = process.env.PORT || 3000

/* Create HTTP server */
http.createServer(app).listen(port)
spinner.succeed(
  `Voiceflow Zendesk KB | API is listening on port ${port}`
)

app.get('/health', async (req, res) => {
  res.json({
    success: true,
    message: 'Server is healthy',
  })
})

/* Get endpoint to check current status  */
app.get('/api/health', async (req, res) => {
  res.json({
    success: true,
    message: 'Server is healthy',
  })
})

/* Post endpoint to trigger the cron update */
app.post('/api/cron', async (req, res) => {
  const expression = req.body.expression || '0 0 * * *'
  const run = req.body.run || false
  const previousDays = req.body.previousDays || process.env.PREVIOUS_DAYS || 7
  let task = cron.schedule(
    expression,
    () => {
      fetchZendeskArticles(null, false, previousDays)
    },
    {
      scheduled: false,
    }
  )

  if (run) {
    res.json({ success: true, message: 'PENDING' })
    // Run the fetchZendeskArticles function once before it starts running on the schedule
    fetchZendeskArticles(null, false, previousDays).then(() => {
      // Start the cron job after fetchZendeskArticles has run once
      task.start()
    })
  } else {
    task.start()
  }
})

/* Post endpoint to trigger the update */
app.post('/api/zendesk', async (req, res) => {
  const apiKey = req.body.apiKey || process.env.VOICEFLOW_KB_API_KEY || null
  const projectID =
    req.body.projectID || process.env.VOICEFLOW_PROJECT_ID || null
  const url = req.body.url || process.env.ZENDESK_SITEMAP || null
  const force = req.body.force || process.env.ALWAYS_FORCE
  const previousDays = req.body.previousDays || process.env.PREVIOUS_DAYS || 30

  if (!apiKey) {
    res.status(500).json({ message: 'No API key provided' })
    return
  }

  if (!projectID) {
    res.status(500).json({ message: 'No project ID provided' })
    return
  }

  if (!url) {
    res.status(500).json({ message: 'No URL provided' })
    return
  }

  try {
    res.json({ success: true, message: 'PENDING' })
    let result = await fetchZendeskArticles(
      url,
      force,
      previousDays,
      apiKey,
      projectID
    )
  } catch (err) {
    res.status(500).json({ message: 'Error processing the sitemap' })
  }
})

/* Function to wait for a certain amount of time */
const sleepWait = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* Function to handle failures and stop queue*/
function handleFailure() {
  failureCount++
  if (failureCount >= process.env.MAX_FAILURES) {
    shouldContinue = false
  }
}

const queue = async.queue((task, callback) => {
  executePostRequest(task.filename, task.apiKey, task.projectID, callback)
    .then(() => {
      failureCount = 0
    })
    .catch((error) => {
      spinner.fail(error.message)
      handleFailure()
      callback(error)
    })
}, 5)

/* Function for the sitemap parser */
async function parseSitemap(url, filter, force, previousDays) {
  const options = {
    delay: 1000,
    limit: 1,
  }
  if (!previousDays) {
    previousDays = process.env.PREVIOUS_DAYS || 30
  }
  if (force !== true) {
    force = null
  }

  const sitemapXMLParser = new SitemapXMLParser(url, options)
  const result = await sitemapXMLParser.fetch()
  const period = new Date()
  period.setDate(period.getDate() - previousDays)

  const filteredData = result.filter((item) => {
    const lastmodDate = new Date(item.lastmod[0])
    return (force || lastmodDate >= period) && item.loc[0].includes(filter)
  })

  let urls = filteredData.map((item) => item.loc[0])
  urls.shift() // Remove the first item in the array (the sitemap itself)
  return urls
}

/* Functions to fetch articles using Zendesk API */
const instance = axios.create({
  baseURL: `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/`,
  timeout: 10000,
  headers: { Authorization: `Basic ${process.env.ZENDESK_API_KEY}` },
})

async function getAllPages(url, dataKey) {
  let response = await instance.get(url)
  let data = response.data[dataKey]

  while (response.data.next_page) {
    response = await instance.get(response.data.next_page)
    data = data.concat(response.data[dataKey])
  }

  return data
}

async function getAllArticles(force, previousDays) {
  const sections = await getAllPages('sections.json', 'sections')
  let allArticles = []

  for (let section of sections) {
    const articles = await getAllPages(
      `en-us/sections/${section.id}/articles.json`,
      'articles'
    )
    allArticles = allArticles.concat(articles)
  }

  if (!previousDays) {
    previousDays = process.env.PREVIOUS_DAYS || 30
  }
  if (force !== true) {
    force = null
  }

  const period = new Date()
  period.setDate(period.getDate() - previousDays)

  const filteredData = allArticles.filter((item) => {
    const lastmodDate = new Date(item.edited_at) //updated_at)
    return force || lastmodDate >= period
  })
  // Extract URLs
  const articleUrls = filteredData.map((article) => article.html_url)

  return articleUrls
}

async function fetchZendeskArticles(
  sitemapURL,
  force,
  previousDays,
  apiKey,
  projectID
) {
  if (!apiKey) {
    apiKey = process.env.VOICEFLOW_KB_API_KEY || null
  }
  failureCount = 0
  shouldContinue = true
  try {
    spinner.start('Processing articles...')
    let sitemapFilter = process.env.ZENDESK_SITEMAP_FILTER || '/articles/'
    if (!sitemapURL) {
      console.log('No sitemap URL provided, using default')
      sitemapURL =
        process.env.ZENDESK_SITEMAP ||
        `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/hc/sitemap.xml`
    }
    // Check if FETCH_METHOD is set to API
    let sitemap
    if (sitemapURL == 'API' || process.env.FETCH_METHOD === 'API') {
      // Fetch articles using Zendesk API
      sitemap = await getAllArticles(force, previousDays)
    } else {
      // Fetch articles using sitemap
      sitemap = await parseSitemap(
        sitemapURL,
        sitemapFilter,
        force,
        previousDays
      )
    }

    if (sitemap.length === 0) {
      console.log(
        '\nNo Article to fetch (check domain and/or previous days value/filter)'
      )
      return 'No Article to fetch (check domain and/or previous days value/filter)'
    } else {
      let count = 0
      let tasks = []
      for (let i = 0; i < sitemap.length; i++) {
        if (!shouldContinue) {
          break
        }
        count = count + 1
        spinner.text = `Adding/Updating [ ${count} of ${sitemap.length} ]`
        await sleepWait(500)
        try {
          const task = await parseZendeskArticles(sitemap[i], apiKey, projectID)
          if (task) {
            tasks.push(task)
          }
          if (tasks.length === 5 || i === sitemap.length - 1) {
            tasks.forEach((task) => queue.push(task))
            await new Promise((resolve) => queue.drain(resolve))
            await sleepWait(2000)
            tasks = []
          }
        } catch (error) {
          if (process.env.DEBUG === 'true') {
            console.log(err)
          }
          handleFailure()
        }
        await sleepWait(500)
      }

      if (shouldContinue) {
        spinner.succeed('Done!')
      } else {
        spinner.fail('Too many failures, stopping processing.')
      }

      return 'KB has been updated'
    }
  } catch (err) {
    if (process.env.DEBUG === 'true') {
      console.log(err)
    }
    spinner.fail('Error processing the sitemap')
    process.exit(1)
    return false
  } finally {
    if (spinner.isSpinning) {
      spinner.stop()
    }
    process.exit(0)
  }
}

/* Function to parse Zendesk articles */
/* Convert from raw HTML to text */
/* Save the txt file */
/* Add to queue for KB upload */
async function parseZendeskArticles(url, apiKey, projectID) {
  const regex = /\/(\d+)-/
  const match = url.match(regex)
  const lastPart = url.substring(url.lastIndexOf('/') + 1)

  let filename = lastPart + '.txt'
  if (match && match[1]) {
    const number = parseInt(match[1], 10)
    const headers = {
      headers: {
        Authorization: `Basic ${process.env.ZENDESK_API_KEY}`,
      },
    }
    const response = await axios.get(
      `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/help_center/en-us/articles/${number}.json`,
      headers
    )

    let title = response?.data?.article?.title
    let body = response?.data?.article?.body

    const options = {
      wordwrap: 130,
    }
    title = convert(title, options).trim()
    body = convert(body, options).trim()

    if (body.length > 3) {
      return await new Promise((resolve, reject) => {
        if (!fs.existsSync(docDir)) {
          // if the directory does not exist, create it
          fs.mkdirSync(docDir, { recursive: true })
        }
        fs.writeFile(
          docDir + filename,
          title + '\n\n' + body,
          'utf8',
          async (err) => {
            if (err) {
              spinner.fail(`Error writing file ${filename}`)
              reject(err)
            } else {
              await sleepWait(2000)
              if (shouldContinue) {
                // Only return the task if shouldContinue is true
                resolve({ filename: filename, apiKey, projectID })
              } else {
                reject(
                  new Error('Stopping processing due to too many failures.')
                )
              }
            }
          }
        )
      })
    }
  } else {
    console.log('No article found')
  }
}

/* Function to upload to KB */
async function executePostRequest(filename, apiKey, projectID, callback) {
  const form = new FormData()
  form.append('file', fs.createReadStream(docDir + filename), filename)

  const options = {
    method: 'POST',
    url: `https://api.voiceflow.com/v3/projects/${projectID}/knowledge-base/documents/file?overwrite=true&maxChunkSize=1500`,
    headers: {
      clientkey: 'ZENDESK_POC',
      Authorization: apiKey,
      ...form.getHeaders(),
    },
    data: form,
  }

  try {
    if (process.env.DEBUG != 'true') {
      const response = await axios.request(options)
    }
    if (process.env.KEEP_DOCS !== 'true') {
      fs.unlink(docDir + filename, (err) => {
        if (err) {
          callback(err) // Call the callback with the error
          return // Return to prevent the callback from being called again
        }
      })
    }
    spinner.text = `✔ Added ${filename}`
    callback()
  } catch (error) {
    console.error(error)
    spinner.fail(`Error adding file ${filename} to KB`)
    throw error
  }
}

async function interactiveFetchZendeskArticles() {
  const menu = [
    {
      type: 'list',
      name: 'menu',
      message: 'Choose an option',
      choices: ['Update KB', 'Exit'],
    },
  ]

  const answersMenu = await inquirer.prompt(menu)
  if (answersMenu.menu === 'Update KB') {
    const questions = [
      {
        type: 'password',
        name: 'apiKey',
        message: 'Your KB API key (default VOICEFLOW_KB_API_KEY)',
        default: process.env.VOICEFLOW_KB_API_KEY || null,
      },
      {
        type: 'input',
        name: 'projectID',
        message: 'Your project ID (default VOICEFLOW_PROJECT_ID)',
        default: process.env.VOICEFLOW_PROJECT_ID || null,
      },
      {
        type: 'confirm',
        name: 'useApi',
        message: 'Do you want to use the Zendesk API to fetch articles?',
        default: true,
      },
      {
        type: 'input',
        name: 'sitemapURL',
        message: 'Enter your sitemap URL',
        default:
          process.env.ZENDESK_SITEMAP ||
          `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/hc/sitemap.xml`,
        when: function (answers) {
          return !answers.useApi // Ask this question only if useApi is false
        },
      },
      {
        type: 'confirm',
        name: 'force',
        message: 'Force update?',
        default: false,
      },
      {
        type: 'input',
        name: 'previousDays',
        message: 'Enter previous days value',
        default: process.env.PREVIOUS_DAYS || 30,
        when: function (answers) {
          return !answers.force // Ask this question only if force is false
        },
      },
    ]

    const answers = await inquirer.prompt(questions)
    fetchZendeskArticles(
      answers.useApi ? 'API' : answers.sitemapURL,
      answers.force,
      answers.previousDays,
      answers.apiKey,
      answers.projectID
    )
  } else if (answersMenu.menu === 'Exit') {
    process.exit()
  }
}

// Check if the app is not running with PM2
if (!process.env.NODE_APP_INSTANCE) {
  // Call the function to start the interactive prompt
  interactiveFetchZendeskArticles()
}

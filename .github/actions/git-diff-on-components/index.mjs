import { readFile } from "fs/promises";
import core from "@actions/core";
import { exec } from "@actions/exec";

console.log("Action version 0.0.17");

const baseCommit = core.getInput("base_commit");
const headCommit = core.getInput("head_commit");
const allFiles = JSON.parse(core.getInput("all_files"));

console.log("baseCommit", baseCommit);
console.log("headCommit", headCommit);
console.log("allFiles", allFiles);

const allowedExtensions = ["js", "mjs", "ts"];
const componentJSFiles = new RegExp("^.*components\/.*\/sources|actions\/.*\.[t|j|mj]s$");
const commonJSFiles = new RegExp("^.*common.*\.[t|j|mj]s$");
const componentVersion = new RegExp("version:", "g");

async function execCmd(...args) {
  let output = "";
  let error = "";

  return new Promise(async (resolve, reject) => {
    await exec(...args, {
      listeners: {
        stdout: (data) => {
          output += data.toString();
        },
        stderr: (data) => {
          error += data.toString();
        }
      }
    });
    if (error) {
      return reject(error);
    }
    return resolve(output)
  });
}

async function run() {
  try {
    const contentFilesPromises =
      allFiles
        .filter((filePath) => {
          const [extension] = filePath.split(".").reverse();
          return !filePath.startsWith(".")
            && allowedExtensions.includes(extension)
            && componentJSFiles.test(filePath)
            && !commonJSFiles.test(filePath);
        })
        .map(async (filePath) => ({
          filePath,
          contents: await readFile(filePath, "utf-8")
        }));

    const contentFiles = await Promise.all(contentFilesPromises);
    // console.log("contentFiles", contentFiles);

    const diffContentPromises =
      contentFiles
        .filter(({ contents }) => contents.includes("version:"))
        .map(async ({ filePath }) => {
          const args = ["diff", "--unified=0", `${baseCommit}...${headCommit}`, filePath];
          return {
            filePath,
            diffContent: await execCmd("git", args)
          };
        });

    const diffContents = await Promise.all(diffContentPromises);
    // console.log("diffContent", diffContent);

    const componentsThatDidNotModifyVersion =
      diffContents
        .filter(({ diffContent }) => !diffContent.includes("version:"))
        .map(({ filePath }) => filePath);

    componentsThatDidNotModifyVersion.forEach((filePath) => {
      console.log(`You didn't modify the version of ${filePath}`);
    });

    if (componentsThatDidNotModifyVersion.length) {
      console.log("You need to increment the version on some components. Please see the output above and https://pipedream.com/docs/components/guidelines/#versioning for more information");
    }

    core.setOutput("components_that_did_not_modify_version", componentsThatDidNotModifyVersion);
  
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
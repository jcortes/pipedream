import { readFile } from "fs/promises";
import core from "@actions/core";
import { exec } from "@actions/exec";

console.log("Action version 0.0.9");

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
    const promises = allFiles
      .filter((filePath) => {
        const [extension] = filePath.split(".").reverse();
        return !filePath.startsWith(".")
          && allowedExtensions.includes(extension)
          && componentJSFiles.test(filePath)
          && !commonJSFiles.test(filePath);
      })
      .filter(async (filePath) => {
        const contents = await readFile(filePath, "utf-8");
        return contents.includes("version:");
      })
      .map(async (filePath) => {
        const args = ["diff", "--unified=0", `${baseCommit}...${headCommit}`, filePath];
        console.log("filePath", filePath);
        const diffContent = await execCmd("git", args);
        console.log("diffContent", diffContent);
        return { filePath, diffContent };
      })
      .map(({ filePath, diffContent }) => {
        const versionHasChanged = diffContent.includes("version:");
        return { filePath, versionHasChanged };
      });

    const responses = await Promise.all(promises);
    console.log("responses", responses);
  
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
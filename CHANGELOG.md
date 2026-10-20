# Change Log

All notable changes to the "stride-language" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Added Stride compilation and launch support via **F5** with 3 execution modes:
  - Run Unit Tests in File (`stridetest`)
  - Compile File to Disk (`stridec` emitting `.o` and `.h`)
  - Build and Flash / Run (target compilation with hardware flashing support prepared for an upcoming release)
- Added interactive Quick-Pick for F5 execution when no `launch.json` is configured.
- Added Editor Title Run button and Context Menu actions for running tests, compiling, and building.
- Added configuration settings `stride.stridecPath` and `stride.stridetestPath` with automatic fallback discovery.
- Initial release
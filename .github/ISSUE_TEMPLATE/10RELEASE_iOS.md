---
name: iOS Release Checklist
about: Add this before doing a new release
title: "[RELEASE] X.X"
labels: ''
assignees: ''

---

# New Release Branch
- [ ] Create "Release X.X" branch with all required changes
- [ ] Create pull request for the release branch into `main`

# Ensure
- [ ] Scheme and Environment are set to PRODUCTION (not Dev or Beta)
- [ ] Version Number is updated
- [ ] Build Number is updated
- [ ] RELEASE_NOTES.MD and CHANGELOG.md are up to date and correct
- [ ] Widget bundle ID is set correctly, can be different if changed for beta testing

# App Store Connect
- [ ] Create new Release
- [ ] Demo Account is Active in Production
- [ ] Add What's New text
- [ ] Add Promotional Text from previous version
- [ ] Check release build version is correct 
- [ ] Version Release is set to "Manually release this version"
- [ ] Phased Release is set to "Release update over 7-day period using phased release"
- [ ] Reset iOS Summary Rating is set to "Keep existing rating"

# Post-Release
- [ ] Merge "Release X.X" pull request in to `main`
- [ ] Merge "Release X.X" branch into `dev` and any other existing branches if any changes were made to "Release X.X"
- [ ] Create new Github release with copy of update notes  
- [ ] Inform James about the release incase any customers are waiting bug fix
- [ ] Download Debug Symbols and include them in the .zip when uploading the XCArchive
- [ ] Upload dSYMs for the XCArchive 
---
name: Web Release Checklist
about: Add this before doing a new release
title: "[RELEASE] X.X"
labels: ''
assignees: ''

---

---
name: Release Checklist
about: Add this before doing a new release
title: "[RELEASE] X.X"
---

# New Release Branch
- [ ] Create "Release X.X" branch with all required changes
- [ ] Create Pull Request for the Release branch into Main

# Pre-Deployment
- [ ] Environment.ts files contain correct configurations
- [ ] Ensure 'changelog.md' is up to date
- [ ] Deploy to Dev and Beta - Double check
- [ ] Check that all console logs are removed

# Deployment
- [ ] Deploy to production

# Post-Release
- [ ] Merge "Release X.X" Pull Request in to Main
- [ ] Create new "Release" on Github with copy of update notes
- [ ] Inform James about the release incase any customers are waiting bug fix
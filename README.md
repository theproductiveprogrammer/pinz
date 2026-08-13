# Pinz - bookmarking tool

## Goals

- Fast
- Clean
- Ordered
- Grouped

## Expected interface

```
Date + Time

[search box]

> #tag1           [Nice Image]
> #tag2
v #tag3
  [Link1]
  [Link2]
  [Link3]
  [Link4]
> #tag4
```

## Data

YAML files in `/data` folder

```
data/
  users.yml
  user1.yml
    - info
      - picture (picture location?) etc
    - links
      - link: https://link
        title:
        tags:
      - link: https://link
        title:
        tags:
      
  user2.yml
  user3.yml
```

## Admin

Command line interface fine to change password of users, add/position image

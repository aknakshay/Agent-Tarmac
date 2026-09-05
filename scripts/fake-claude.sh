#!/bin/sh
echo "fake claude starting session ${2:-none}"
sleep 1
echo "Do you want to continue?"
# stay alive reading stdin; exit on "q"
while read -r line; do
  [ "$line" = "q" ] && echo "bye" && exit 0
  echo "got: $line"
done
